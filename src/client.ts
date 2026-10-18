import { PlanError, errorFromResponse } from "./errors.js";
import { verifyIdToken } from "./jwt.js";
import {
  DYNAMIC_CLIENT_ID,
  IDENTITY_SCOPES,
  PLAN_SCOPE,
  PLAN_SCOPES,
  RESOURCE,
  exchangeCode,
  openInBrowser,
  pkcePair,
  randomToken,
  refreshTokens,
  revokeRefreshToken,
  startLoopback,
  type Discovery,
  type TokenResponse,
} from "./oauth.js";
import { buildBody, checkedEvents, parseSse, type ResponseParams, type StreamEvent } from "./responses.js";
import { FileStore, defaultConfigDir, newHostId, type AccountRecord, type CredentialStore, type StoreData } from "./store.js";

export interface PlanClientOptions {
  /** Your app's real name, shown to the user during first-time registration (`agent_name_hint`). */
  appName: string;
  /** Directory name for credentials under ~/.config. Defaults to a slug of appName. */
  appId?: string;
  /** Where credentials are kept. Defaults to an owner-only JSON file under ~/.config/<appId>. */
  store?: CredentialStore;
  /** Called with the authorization URL. Return false if it could not be opened. Defaults to the system browser. */
  openBrowser?: (url: string) => boolean | void | Promise<boolean | void>;
  /** Preferred loopback port for the OAuth callback; falls back to any free port. */
  callbackPort?: number;
  /** Refresh the access token when it has less than this many ms left. */
  refreshWindowMs?: number;
  onWarning?: (message: string) => void;
  issuer?: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

export interface AccountSummary {
  id: string;
  email?: string;
  name?: string;
  /** Has usable tokens. */
  signedIn: boolean;
  /** The user granted ChatGPT plan usage. */
  planEnabled: boolean;
  active: boolean;
}

export interface Model {
  slug: string;
  displayName: string;
}

export interface SignInOptions {
  /** Reauthorize a saved account (its id) instead of registering a new one. */
  account?: string;
  /** Ask the user to review consent again, e.g. to enable plan usage after declining it. */
  forceConsent?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RequestOptions {
  account?: string;
  signal?: AbortSignal;
}

const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plankit-app";
}

export class PlanClient {
  readonly appName: string;
  readonly store: CredentialStore;
  private readonly issuer: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshWindowMs: number;
  private discovery?: Promise<Discovery>;
  private jwks?: { keys: any[] };

  constructor(private readonly opts: PlanClientOptions) {
    if (!opts.appName) throw new TypeError("appName is required");
    this.appName = opts.appName;
    this.store = opts.store ?? new FileStore(defaultConfigDir(opts.appId ?? slug(opts.appName)));
    this.issuer = (opts.issuer ?? "https://auth.openai.com").replace(/\/$/, "");
    this.apiBase = (opts.apiBase ?? RESOURCE).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.refreshWindowMs = opts.refreshWindowMs ?? 5 * 60_000;
  }

  // ---- accounts -------------------------------------------------------------------------------

  async status(): Promise<{ hostId: string; active?: AccountSummary; accounts: AccountSummary[] }> {
    const data = await this.load();
    const accounts = Object.values(data.accounts).map((a) => summarize(a, data.activeClientId));
    return { hostId: data.hostId, active: accounts.find((a) => a.active), accounts };
  }

  async useAccount(id: string): Promise<void> {
    await this.mutate((d) => {
      if (!d.accounts[id]) throw new PlanError("unknown_account", `No saved account ${id}`);
      d.activeClientId = id;
    });
  }

  /** Forget an account entirely, including its client registration. Prefer signOut() for normal sign-out. */
  async removeAccount(id: string): Promise<void> {
    await this.signOut({ account: id }).catch(() => {});
    await this.mutate((d) => {
      delete d.accounts[id];
      if (d.activeClientId === id) d.activeClientId = Object.keys(d.accounts)[0];
    });
  }

  /**
   * Run the browser sign-in. With no `account`, registers a new client (first-time flow); with an `account`,
   * reauthorizes that saved registration. The account becomes active only after its ID token is validated.
   */
  async signIn(options: SignInOptions = {}): Promise<AccountSummary> {
    const data = await this.load();
    const existing = options.account ? data.accounts[options.account] : undefined;
    if (options.account && !existing) throw new PlanError("unknown_account", `No saved account ${options.account}`);

    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkcePair();
    const listener = await startLoopback(state, this.opts.callbackPort ?? 1455, options.timeoutMs);
    const onAbort = () => listener.close();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const q = new URLSearchParams({
        client_id: existing?.clientId ?? DYNAMIC_CLIENT_ID,
        ext_agent_host_id: data.hostId,
        response_type: "code",
        redirect_uri: listener.redirectUri,
        scope: [...IDENTITY_SCOPES, ...PLAN_SCOPES].join(" "),
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: challenge,
      });
      if (!existing) q.set("agent_name_hint", this.appName);
      if (existing?.idToken) q.set("id_token_hint", existing.idToken);
      if (existing?.email) q.set("login_hint", existing.email);
      if (options.forceConsent) q.set("prompt", "consent");

      // This URL may carry id_token_hint: hand it to the opener, never log it.
      const authUrl = `${this.issuer}/api/accounts/authorize?${q}`;
      const opened = await (this.opts.openBrowser ?? openInBrowser)(authUrl);
      if (opened === false) throw new PlanError("browser_unavailable", "Could not open a browser for sign-in");

      const { params } = await listener.result;
      if (params.has("error")) {
        const code = params.get("error")!;
        throw new PlanError(code, params.get("error_description") ?? `Sign-in failed: ${code}`);
      }
      const code = params.get("code");
      if (!code) throw new PlanError("invalid_callback", "Callback had no authorization code");

      const returned = params.get("client_id") ?? undefined;
      let clientId: string;
      if (existing) {
        if (returned && returned !== existing.clientId) {
          throw new PlanError("client_mismatch", "Callback returned a different client ID than the selected account");
        }
        clientId = existing.clientId;
      } else {
        if (!returned || returned === DYNAMIC_CLIENT_ID) {
          throw new PlanError("registration_incomplete", "Registration callback did not include an issued client ID");
        }
        clientId = returned;
      }

      const tokens = await exchangeCode(
        `${this.issuer}/api/accounts/oauth/token`,
        { clientId, code, verifier, redirectUri: listener.redirectUri },
        this.fetchImpl,
      );
      if (!tokens.id_token) throw new PlanError("invalid_id_token", "Token response had no ID token");
      const claims = await this.verify(tokens.id_token, clientId, nonce);

      const prior = existing ?? data.accounts[clientId];
      if (prior && prior.subject !== claims.sub) {
        throw new PlanError("account_mismatch", "Signed in as a different ChatGPT account than the one selected");
      }

      const record: AccountRecord = {
        ...withTokens(
          { clientId, issuer: claims.iss, subject: claims.sub, scopes: [], savedAt: "" },
          tokens,
        ),
        email: typeof claims.email === "string" ? claims.email : prior?.email,
        name: typeof claims.name === "string" ? claims.name : prior?.name,
        idToken: tokens.id_token,
      };
      const saved = await this.mutate((d) => {
        d.accounts[clientId] = record;
        d.activeClientId = clientId;
      });
      return summarize(saved.accounts[clientId], clientId);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      listener.close();
    }
  }

  /**
   * Sign out: revoke the refresh token, then clear tokens locally. The client registration and host ID are kept
   * so the next sign-in reuses them. `revoked: false` means remote revocation was not confirmed; tell the user
   * they can disconnect the app in ChatGPT settings.
   */
  async signOut(options: { account?: string } = {}): Promise<{ revoked: boolean }> {
    const data = await this.load();
    const id = options.account ?? data.activeClientId;
    const acct = id ? data.accounts[id] : undefined;
    if (!acct) return { revoked: true };

    let revoked = !acct.refreshToken;
    if (acct.refreshToken) {
      const endpoint = (await this.getDiscovery().catch(() => undefined))?.revocation_endpoint;
      revoked = endpoint
        ? await revokeRefreshToken(endpoint, { clientId: acct.clientId, refreshToken: acct.refreshToken }, this.fetchImpl)
        : false;
    }
    await this.mutate((d) => {
      const a = d.accounts[acct.clientId];
      if (a) clearTokens(a, { idToken: true });
    });
    return { revoked };
  }

  // ---- tokens ---------------------------------------------------------------------------------

  /** A valid access token for the account, refreshing (serialized across processes) when close to expiry. */
  async getAccessToken(options: { account?: string; force?: boolean } = {}): Promise<string> {
    const acct = await this.account(options.account);
    if (!needsRefresh(acct, this.refreshWindowMs, options.force)) return acct.accessToken!;

    return this.store.lock(async () => {
      // Another process may have refreshed while we waited for the lock.
      const data = await this.loadLocked();
      const current = data.accounts[acct.clientId];
      if (!current?.refreshToken) throw new PlanError("not_signed_in", "Sign in with ChatGPT to continue");
      if (current.accessToken && current.accessToken !== acct.accessToken && (current.expiresAt ?? 0) - Date.now() > 30_000) {
        return current.accessToken;
      }

      let tokens: TokenResponse;
      try {
        tokens = await refreshTokens(
          `${this.issuer}/api/accounts/oauth/token`,
          { clientId: current.clientId, refreshToken: current.refreshToken },
          this.fetchImpl,
        );
      } catch (e) {
        if (e instanceof PlanError && e.recovery === "sign_in") {
          clearTokens(current, { idToken: false });
          await this.store.write(data);
          throw new PlanError("reauth_required", "ChatGPT session ended; sign in again", { cause: e });
        }
        // Transient failure: keep credentials and use the current token while it is still valid.
        if (current.accessToken && (current.expiresAt ?? 0) - Date.now() > 30_000) return current.accessToken;
        throw e;
      }
      data.accounts[current.clientId] = withTokens(current, tokens);
      await this.store.write(data);
      return tokens.access_token;
    });
  }

  // ---- inference ------------------------------------------------------------------------------

  /** Models available to the signed-in account, in server order. */
  async models(options: RequestOptions = {}): Promise<Model[]> {
    const res = await this.authed("/models", { method: "GET", signal: options.signal }, options.account);
    const body: any = await res.json();
    if (Array.isArray(body.models)) {
      return body.models
        .filter((m: any) => m.visibility === undefined || m.visibility === "list")
        .map((m: any) => ({ slug: m.slug ?? m.id, displayName: m.display_name ?? m.slug ?? m.id }));
    }
    return (body.data ?? []).map((m: any) => ({ slug: m.id, displayName: m.id }));
  }

  /** Stream raw Responses API events. Throws PlanError on failure, including usage limits that arrive mid-stream. */
  async *stream(params: ResponseParams, options: RequestOptions = {}): AsyncGenerator<StreamEvent> {
    const body = buildBody(params, this.opts.onWarning ?? ((m) => console.warn(m)));
    const res = await this.authed(
      "/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
      options.account,
    );
    if (!res.body) throw new PlanError("empty_response", "Response had no body");
    yield* checkedEvents(parseSse(res.body), res.headers.get("x-request-id") ?? undefined);
  }

  /** Stream just the output text deltas. */
  async *streamText(params: ResponseParams, options: RequestOptions = {}): AsyncGenerator<string> {
    for await (const ev of this.stream(params, options)) {
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") yield ev.delta;
    }
  }

  /** Run a request to completion and return its output text. */
  async text(params: ResponseParams, options: RequestOptions = {}): Promise<string> {
    let out = "";
    for await (const d of this.streamText(params, options)) out += d;
    return out;
  }

  // ---- internals ------------------------------------------------------------------------------

  private async authed(path: string, init: RequestInit, account?: string): Promise<Response> {
    const send = (token: string) =>
      this.fetchImpl(`${this.apiBase}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      });
    let res = await send(await this.getAccessToken({ account }));
    if (res.status === 401) {
      // The token may have been rotated or revoked elsewhere; refresh once and retry.
      await res.body?.cancel();
      res = await send(await this.getAccessToken({ account, force: true }));
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }

  private async account(id?: string): Promise<AccountRecord> {
    const data = await this.load();
    const key = id ?? data.activeClientId;
    const acct = key ? data.accounts[key] : undefined;
    if (!acct?.refreshToken && !acct?.accessToken) throw new PlanError("not_signed_in", "Sign in with ChatGPT to continue");
    if (!acct.scopes.includes(PLAN_SCOPE)) {
      throw new PlanError("plan_not_enabled", "ChatGPT plan usage was not granted for this account");
    }
    return acct;
  }

  private async load(): Promise<StoreData> {
    return (await this.store.read()) ?? this.store.lock(() => this.loadLocked());
  }

  /** Read the store, creating it (and the persistent host ID) on first use. Caller must hold the lock. */
  private async loadLocked(): Promise<StoreData> {
    const data = await this.store.read();
    if (data) return data;
    const fresh: StoreData = { version: 1, hostId: newHostId(), accounts: {} };
    await this.store.write(fresh);
    return fresh;
  }

  private mutate(fn: (d: StoreData) => void): Promise<StoreData> {
    return this.store.lock(async () => {
      const data = await this.loadLocked();
      fn(data);
      await this.store.write(data);
      return data;
    });
  }

  private getDiscovery(): Promise<Discovery> {
    this.discovery ??= this.fetchImpl(`${this.issuer}/.well-known/openid-configuration`).then(async (r) => {
      if (!r.ok) throw new PlanError("discovery_failed", `OpenID discovery failed: HTTP ${r.status}`);
      return (await r.json()) as Discovery;
    });
    this.discovery.catch(() => (this.discovery = undefined));
    return this.discovery;
  }

  private async loadJwks(force = false): Promise<{ keys: any[] }> {
    if (this.jwks && !force) return this.jwks;
    const { jwks_uri } = await this.getDiscovery();
    const r = await this.fetchImpl(jwks_uri);
    if (!r.ok) throw new PlanError("jwks_failed", `Fetching signing keys failed: HTTP ${r.status}`);
    this.jwks = (await r.json()) as { keys: any[] };
    return this.jwks;
  }

  private async verify(idToken: string, clientId: string, nonce: string) {
    const expected = { issuer: this.issuer, audience: clientId, nonce };
    try {
      return verifyIdToken(idToken, await this.loadJwks(), expected);
    } catch (e) {
      // Keys may have rotated since we cached them.
      if (e instanceof PlanError && e.message.includes("No matching signing key")) {
        return verifyIdToken(idToken, await this.loadJwks(true), expected);
      }
      throw e;
    }
  }
}

function needsRefresh(a: AccountRecord, windowMs: number, force?: boolean): boolean {
  if (!a.accessToken || !a.expiresAt) return true;
  if (force) return true;
  const left = a.expiresAt - Date.now();
  // Never refresh in the first half of a token's life, even if it is shorter than the window.
  const lifetime = a.expiresAt - Date.parse(a.savedAt);
  if (left > Math.min(windowMs, lifetime > 0 ? lifetime / 2 : windowMs)) return false;
  if (left < 30_000) return true;
  return !a.earliestRefreshAt || Date.now() >= a.earliestRefreshAt;
}

function withTokens(a: AccountRecord, t: TokenResponse): AccountRecord {
  const now = Date.now();
  return {
    ...a,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? a.refreshToken,
    tokenType: t.token_type ?? "Bearer",
    expiresAt: now + (t.expires_in ?? 3600) * 1000,
    earliestRefreshAt: t.earliest_refresh_at ? toMs(t.earliest_refresh_at) : undefined,
    scopes: t.scope ? t.scope.split(" ").filter(Boolean) : a.scopes,
    savedAt: new Date(now).toISOString(),
  };
}

function clearTokens(a: AccountRecord, opts: { idToken: boolean }) {
  delete a.accessToken;
  delete a.refreshToken;
  delete a.expiresAt;
  delete a.earliestRefreshAt;
  if (opts.idToken) delete a.idToken;
}

function summarize(a: AccountRecord, activeId?: string): AccountSummary {
  return {
    id: a.clientId,
    email: a.email,
    name: a.name,
    signedIn: Boolean(a.refreshToken || a.accessToken),
    planEnabled: a.scopes.includes(PLAN_SCOPE),
    active: a.clientId === activeId,
  };
}

export function createPlanClient(options: PlanClientOptions): PlanClient {
  return new PlanClient(options);
}
