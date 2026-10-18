// A local stand-in for auth.openai.com + api.openai.com implementing the documented plan-usage flow.
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const rand = () => randomBytes(12).toString("hex");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const PLAN_SCOPES = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
const ID_SCOPES = "email openid profile";

export async function startMock() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key";
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };

  const m = {
    base: "",
    sub: "user-1",
    email: "ada@example.com",
    expiresIn: 3600,
    grantPlan: true,
    denyNext: false,
    badNonce: false,
    scenario: "ok",
    authorizeRequests: [],
    responseBodies: [],
    refreshCount: 0,
    revoked: [],
    codes: new Map(),
    access: new Map(), // token -> { clientId, exp }
    refresh: new Map(), // token -> { clientId, used, sub, scope }
    clients: new Set(),
  };

  const idToken = (clientId, nonce) => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: "RS256", kid, typ: "JWT" });
    const payload = b64({ iss: m.base, sub: m.sub, aud: clientId, exp: now + 3600, iat: now, nonce: m.badNonce ? "wrong" : nonce, email: m.email, name: "Ada" });
    const sig = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${sig}`;
  };

  const issue = (clientId, nonce, scope, sub) => {
    const access_token = `at_${rand()}`;
    const refresh_token = `rt_${rand()}`;
    m.access.set(access_token, { clientId, exp: Date.now() + m.expiresIn * 1000 });
    m.refresh.set(refresh_token, { clientId, used: false, sub, scope, nonce });
    return { access_token, refresh_token, id_token: idToken(clientId, nonce), token_type: "Bearer", expires_in: m.expiresIn, scope };
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_test", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((r) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => r(s));
    });

  const bearer = (req) => {
    const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const a = m.access.get(t);
    return a && a.exp > Date.now() ? a : null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, m.base);
    const p = url.pathname;

    if (p === "/.well-known/openid-configuration") {
      return json(res, 200, { issuer: m.base, jwks_uri: `${m.base}/jwks`, revocation_endpoint: `${m.base}/api/accounts/oauth/revoke` });
    }
    if (p === "/jwks") return json(res, 200, { keys: [jwk] });

    if (p === "/api/accounts/authorize") {
      const q = url.searchParams;
      m.authorizeRequests.push(Object.fromEntries(q));
      const redirect = q.get("redirect_uri");
      if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirect ?? "")) return json(res, 400, { error: "bad_redirect" });
      for (const k of ["ext_agent_host_id", "state", "nonce", "code_challenge"]) if (!q.get(k)) return json(res, 400, { error: `missing_${k}` });
      if (q.get("code_challenge_method") !== "S256" || q.get("resource") !== "https://api.openai.com/v1") return json(res, 400, { error: "bad_params" });
      const out = new URL(redirect);
      out.searchParams.set("state", q.get("state"));
      if (m.denyNext) {
        m.denyNext = false;
        out.searchParams.set("error", "access_denied");
        res.writeHead(302, { location: out.toString() }).end();
        return;
      }
      let clientId = q.get("client_id");
      const isNew = clientId === "dynamic_agent_client";
      if (isNew) {
        clientId = `oaiapp_${rand()}`;
        m.clients.add(clientId);
      } else if (!m.clients.has(clientId)) return json(res, 400, { error: "invalid_client" });
      const code = `code_${rand()}`;
      const scope = m.grantPlan ? PLAN_SCOPES : ID_SCOPES;
      m.codes.set(code, { clientId, challenge: q.get("code_challenge"), redirect, nonce: q.get("nonce"), scope });
      out.searchParams.set("code", code);
      out.searchParams.set("scope", scope);
      if (isNew) out.searchParams.set("client_id", clientId);
      res.writeHead(302, { location: out.toString() }).end();
      return;
    }

    if (p === "/api/accounts/oauth/token" && req.method === "POST") {
      const f = new URLSearchParams(await readBody(req));
      if (f.get("resource") !== "https://api.openai.com/v1") return json(res, 400, { error: "invalid_target" });
      if (f.get("grant_type") === "authorization_code") {
        const c = m.codes.get(f.get("code"));
        m.codes.delete(f.get("code"));
        if (!c) return json(res, 400, { error: "invalid_grant" });
        const challenge = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (challenge !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
        if (f.get("client_id") !== c.clientId || f.get("redirect_uri") !== c.redirect) return json(res, 400, { error: "invalid_grant" });
        return json(res, 200, issue(c.clientId, c.nonce, c.scope, m.sub));
      }
      if (f.get("grant_type") === "refresh_token") {
        const r = m.refresh.get(f.get("refresh_token"));
        if (!r) return json(res, 400, { error: "invalid_grant" });
        if (r.used) return json(res, 400, { error: "refresh_token_reused" });
        if (r.clientId !== f.get("client_id")) return json(res, 401, { error: "invalid_client" });
        r.used = true;
        m.refreshCount++;
        await new Promise((ok) => setTimeout(ok, 30)); // widen the race window
        return json(res, 200, issue(r.clientId, r.nonce, r.scope, r.sub));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }

    if (p === "/api/accounts/oauth/revoke" && req.method === "POST") {
      const f = new URLSearchParams(await readBody(req));
      m.revoked.push(f.get("token"));
      m.refresh.delete(f.get("token"));
      res.writeHead(200).end();
      return;
    }

    if (p === "/v1/models") {
      if (!bearer(req)) return json(res, 401, { error: { code: "invalid_token", message: "bad token" } });
      return json(res, 200, {
        models: [
          { slug: "gpt-test", display_name: "GPT Test", visibility: "list" },
          { slug: "internal", display_name: "Internal", visibility: "hide" },
        ],
      });
    }

    if (p === "/v1/responses" && req.method === "POST") {
      if (!bearer(req)) return json(res, 401, { error: { code: "invalid_token", message: "bad token" } });
      const body = JSON.parse(await readBody(req));
      m.responseBodies.push(body);
      if (body.store !== false || body.stream !== true) return json(res, 400, { error: { code: "subscription_sharing_unsupported_capability", param: "store" } });
      if (body.temperature !== undefined) return json(res, 400, { error: { code: "subscription_sharing_unsupported_capability", param: "temperature" } });
      if (body.input.some((i) => i.role === "system")) return json(res, 400, { error: { code: "invalid_value", param: "input" } });

      if (m.scenario === "limit_429") {
        return json(res, 429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached" } });
      }
      if (m.scenario === "detail_503") return json(res, 503, { detail: "Direct routing unavailable" });

      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_stream" });
      const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      send({ type: "response.created", response: { id: "resp_1" } });
      send({ type: "response.output_text.delta", delta: "Hello" });
      if (m.scenario === "limit_midstream") {
        send({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached" } } });
        return res.end();
      }
      if (m.scenario === "truncated") return res.end();
      // Split a frame across writes to exercise the SSE parser's buffering.
      const frame = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: ", world" })}\n\n`;
      res.write(frame.slice(0, 20));
      await new Promise((ok) => setTimeout(ok, 10));
      res.write(frame.slice(20));
      send({ type: "response.completed", response: { id: "resp_1", status: "completed" } });
      res.end("data: [DONE]\n\n");
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  m.base = `http://127.0.0.1:${server.address().port}`;
  m.close = () => new Promise((r) => {
    server.closeAllConnections();
    server.close(r);
  });
  /** Act as the user's browser: follow the authorize redirect to the app's loopback callback. */
  m.browser = async (url) => {
    void (async () => {
      const r = await fetch(url, { redirect: "manual" });
      const loc = r.headers.get("location");
      if (loc) await fetch(loc);
    })();
    return true;
  };
  /** Expire every access token so the next call must refresh. */
  m.expireAccess = () => {
    for (const a of m.access.values()) a.exp = 0;
  };
  return m;
}
