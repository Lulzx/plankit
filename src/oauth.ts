import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { PlanError } from "./errors.js";

export const RESOURCE = "https://api.openai.com/v1";
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const IDENTITY_SCOPES = ["openid", "profile", "email"];
export const PLAN_SCOPES = ["offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CALLBACK_PATH = "/auth/callback";

/** Refresh-token failures that mean the user has to sign in again. */
const UNUSABLE_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: number;
}

export interface Discovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  [k: string]: unknown;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface CallbackResult {
  params: URLSearchParams;
}

export interface LoopbackListener {
  redirectUri: string;
  /** Resolves with the first callback whose `state` matches. */
  result: Promise<CallbackResult>;
  close(): void;
}

const DONE_PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#222">` +
  `<div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`;

/** Listen on 127.0.0.1 (never `localhost`), preferring `preferredPort` and falling back to any free port. */
export async function startLoopback(state: string, preferredPort = 1455, timeoutMs = 300_000): Promise<LoopbackListener> {
  let resolve!: (r: CallbackResult) => void;
  let reject!: (e: unknown) => void;
  const result = new Promise<CallbackResult>((res, rej) => ((resolve = res), (reject = rej)));

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/html" }).end(DONE_PAGE("Sign-in failed", "This sign-in link has expired. Return to the app and try again."));
      return;
    }
    const failed = url.searchParams.has("error");
    res
      .writeHead(200, { "content-type": "text/html", connection: "close" })
      .end(failed ? DONE_PAGE("Sign-in cancelled", "You can close this tab.") : DONE_PAGE("You're signed in", "You can close this tab and return to the app."));
    resolve({ params: url.searchParams });
  });

  const listen = (port: number) =>
    new Promise<number>((res, rej) => {
      server.once("error", rej);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", rej);
        res((server.address() as { port: number }).port);
      });
    });

  let port: number;
  try {
    port = await listen(preferredPort);
  } catch (e: any) {
    if (e?.code !== "EADDRINUSE" && e?.code !== "EACCES") throw e;
    port = await listen(0);
  }

  const timer = setTimeout(() => reject(new PlanError("sign_in_timeout", "Timed out waiting for the browser sign-in")), timeoutMs);
  timer.unref();
  const close = () => {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
  };
  result.then(close, close);

  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    result,
    close: () => {
      reject(new PlanError("sign_in_cancelled", "Sign-in was cancelled"));
      close();
    },
  };
}

/** Open a URL in the system browser. Resolves false if no opener could be launched. */
export function openInBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((res) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.once("error", () => res(false));
      child.once("spawn", () => {
        child.unref();
        res(true);
      });
    } catch {
      res(false);
    }
  });
}

async function postForm(url: string, form: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
  });
}

async function tokenError(res: Response): Promise<PlanError> {
  const text = await res.text().catch(() => "");
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {}
  const code: string = (typeof body.error === "string" ? body.error : body.error?.code) ?? `http_${res.status}`;
  const message: string = body.error_description ?? body.error?.message ?? text ?? res.statusText;
  if (UNUSABLE_REFRESH.has(code)) return new PlanError(code, message, { status: res.status, recovery: "sign_in" });
  if (code === "invalid_client") return new PlanError(code, message, { status: res.status, recovery: "none" });
  return new PlanError(code, message, { status: res.status });
}

export async function exchangeCode(
  tokenUrl: string,
  args: { clientId: string; code: string; verifier: string; redirectUri: string },
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const res = await postForm(
    tokenUrl,
    {
      grant_type: "authorization_code",
      client_id: args.clientId,
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri,
      resource: RESOURCE,
    },
    fetchImpl,
  );
  if (!res.ok) throw await tokenError(res);
  return (await res.json()) as TokenResponse;
}

export async function refreshTokens(
  tokenUrl: string,
  args: { clientId: string; refreshToken: string },
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  // Omit `scope` so the existing grant is retained.
  const res = await postForm(
    tokenUrl,
    { grant_type: "refresh_token", client_id: args.clientId, refresh_token: args.refreshToken, resource: RESOURCE },
    fetchImpl,
  );
  if (!res.ok) throw await tokenError(res);
  return (await res.json()) as TokenResponse;
}

/** Revoke a refresh token, retrying network errors and 5xx. Returns whether revocation was confirmed. */
export async function revokeRefreshToken(
  revocationUrl: string,
  args: { clientId: string; refreshToken: string },
  fetchImpl: typeof fetch,
  attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await postForm(
        revocationUrl,
        { token: args.refreshToken, token_type_hint: "refresh_token", client_id: args.clientId },
        fetchImpl,
      );
      if (res.ok) return true;
      if (res.status < 500) return false;
    } catch {}
    await new Promise((r) => setTimeout(r, 250 * 2 ** i));
  }
  return false;
}
