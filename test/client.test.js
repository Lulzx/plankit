import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanClient, FileStore, PlanError } from "../dist/index.js";
import { startMock } from "./mock-server.js";

let mock;
let dir;
const warnings = [];

before(async () => {
  mock = await startMock();
});
after(() => mock.close());
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plankit-"));
  Object.assign(mock, { scenario: "ok", grantPlan: true, denyNext: false, badNonce: false, expiresIn: 3600, sub: "user-1", refreshCount: 0 });
  mock.authorizeRequests.length = 0;
  mock.responseBodies.length = 0;
  warnings.length = 0;
});

const client = (extra = {}) =>
  createPlanClient({
    appName: "Test App",
    store: new FileStore(dir),
    issuer: mock.base,
    apiBase: `${mock.base}/v1`,
    openBrowser: mock.browser,
    callbackPort: 0,
    onWarning: (w) => warnings.push(w),
    ...extra,
  });

/** Pretend an hour has passed: every stored access token has a minute left. */
async function ageTokens() {
  const store = new FileStore(dir);
  const data = await store.read();
  for (const a of Object.values(data.accounts)) {
    a.savedAt = new Date(Date.now() - 3540_000).toISOString();
    a.expiresAt = Date.now() + 60_000;
  }
  await store.write(data);
}

const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof PlanError && e.code === code);

test("first sign-in registers a client and stores credentials owner-only", async () => {
  const plan = client();
  const acct = await plan.signIn();
  assert.match(acct.id, /^oaiapp_/);
  assert.equal(acct.email, "ada@example.com");
  assert.ok(acct.signedIn && acct.planEnabled && acct.active);

  const q = mock.authorizeRequests[0];
  assert.equal(q.client_id, "dynamic_agent_client");
  assert.equal(q.agent_name_hint, "Test App");
  assert.match(q.ext_agent_host_id, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(q.scope, "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");

  if (process.platform !== "win32") assert.equal((await stat(join(dir, "credentials.json"))).mode & 0o777, 0o600);
  const s = await plan.status();
  assert.equal(s.hostId, q.ext_agent_host_id);
});

test("reauthorization reuses the issued client, host ID, and hints", async () => {
  const plan = client();
  const first = await plan.signIn();
  await plan.signIn({ account: first.id });
  const [a, b] = mock.authorizeRequests;
  assert.equal(b.client_id, first.id);
  assert.equal(b.ext_agent_host_id, a.ext_agent_host_id);
  assert.equal(b.agent_name_hint, undefined);
  assert.equal(b.login_hint, "ada@example.com");
  assert.ok(b.id_token_hint);
});

test("reauthorization as a different person is rejected", async () => {
  const plan = client();
  const first = await plan.signIn();
  mock.sub = "someone-else";
  await rejectsWith(plan.signIn({ account: first.id }), "account_mismatch");
});

test("streams text and shapes the request for the plan-usage route", async () => {
  const plan = client();
  await plan.signIn();
  const out = await plan.text({
    model: "gpt-test",
    input: [
      { role: "system", content: "Be brief" },
      { role: "user", content: "hi" },
    ],
    temperature: 0.2,
  });
  assert.equal(out, "Hello, world");
  const body = mock.responseBodies[0];
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.temperature, undefined);
  assert.equal(body.input[0].role, "developer");
  assert.match(warnings[0], /temperature/);
});

test("lists only models meant for display", async () => {
  const plan = client();
  await plan.signIn();
  assert.deepEqual(await plan.models(), [{ slug: "gpt-test", displayName: "GPT Test" }]);
});

test("refreshes near expiry and persists the rotated refresh token", async () => {
  const plan = client();
  await plan.signIn();
  await ageTokens();
  const before = (await new FileStore(dir).read()).accounts;
  await plan.models();
  assert.equal(mock.refreshCount, 1);
  const afterRec = Object.values((await new FileStore(dir).read()).accounts)[0];
  assert.notEqual(afterRec.refreshToken, Object.values(before)[0].refreshToken);
});

test("concurrent refreshes from separate processes don't reuse a rotating token", async () => {
  await client().signIn();
  await ageTokens();
  // Separate client instances share only the file, like separate processes.
  const results = await Promise.all(Array.from({ length: 5 }, () => client().getAccessToken()));
  assert.equal(mock.refreshCount, 1);
  assert.equal(new Set(results).size, 1);
});

test("a 401 triggers one refresh and a retry", async () => {
  const plan = client();
  await plan.signIn();
  mock.expireAccess();
  assert.equal(await plan.text({ model: "gpt-test", input: "hi" }), "Hello, world");
  assert.equal(mock.refreshCount, 1);
});

test("usage limit arriving mid-stream surfaces as manage_usage", async () => {
  const plan = client();
  await plan.signIn();
  mock.scenario = "limit_midstream";
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const d of plan.streamText({ model: "gpt-test", input: "hi" })) seen.push(d);
    })(),
    (e) => e.code === "subscription_sharing_usage_limit_exceeded" && e.recovery === "manage_usage" && e.requestId === "req_stream",
  );
  assert.deepEqual(seen, ["Hello"]);
});

test("pre-stream errors keep their code, status, and request ID", async () => {
  const plan = client();
  await plan.signIn();
  mock.scenario = "limit_429";
  await assert.rejects(plan.text({ model: "gpt-test", input: "hi" }), (e) => e.status === 429 && e.recovery === "manage_usage" && e.requestId === "req_test");
  mock.scenario = "detail_503";
  await assert.rejects(plan.text({ model: "gpt-test", input: "hi" }), (e) => e.code === "http_503" && e.message === "Direct routing unavailable" && e.retryable);
});

test("a stream that ends without response.completed is an error", async () => {
  const plan = client();
  await plan.signIn();
  mock.scenario = "truncated";
  await rejectsWith(plan.text({ model: "gpt-test", input: "hi" }), "stream_interrupted");
});

test("declined plan usage keeps the sign-in but blocks inference", async () => {
  mock.grantPlan = false;
  const plan = client();
  const acct = await plan.signIn();
  assert.equal(acct.signedIn, true);
  assert.equal(acct.planEnabled, false);
  await rejectsWith(plan.text({ model: "gpt-test", input: "hi" }), "plan_not_enabled");
  mock.grantPlan = true;
  const again = await plan.signIn({ account: acct.id, forceConsent: true });
  assert.equal(again.planEnabled, true);
  assert.equal(mock.authorizeRequests.at(-1).prompt, "consent");
});

test("access_denied at the consent screen", async () => {
  mock.denyNext = true;
  await rejectsWith(client().signIn(), "access_denied");
});

test("an ID token with the wrong nonce is rejected", async () => {
  mock.badNonce = true;
  await rejectsWith(client().signIn(), "invalid_id_token");
});

test("sign-out revokes, clears tokens, and keeps the registration", async () => {
  const plan = client();
  const acct = await plan.signIn();
  const rt = Object.values((await new FileStore(dir).read()).accounts)[0].refreshToken;
  assert.deepEqual(await plan.signOut(), { revoked: true });
  assert.ok(mock.revoked.includes(rt));
  const rec = (await new FileStore(dir).read()).accounts[acct.id];
  assert.equal(rec.refreshToken, undefined);
  assert.equal(rec.idToken, undefined);
  assert.equal(rec.clientId, acct.id);
  await rejectsWith(plan.text({ model: "gpt-test", input: "hi" }), "not_signed_in");
});

test("a dead refresh token requires signing in again", async () => {
  const plan = client();
  await plan.signIn();
  await ageTokens();
  mock.refresh.clear(); // e.g. the user disconnected the app in ChatGPT settings
  await assert.rejects(plan.models(), (e) => e.code === "reauth_required" && e.recovery === "sign_in");
  assert.equal((await plan.status()).active.signedIn, false);
});

test("a callback with the wrong state is ignored", async () => {
  const plan = client({
    openBrowser: async (url) => {
      const redirect = new URL(url).searchParams.get("redirect_uri");
      const bad = await fetch(`${redirect}?code=x&state=forged&client_id=oaiapp_evil`);
      assert.equal(bad.status, 400);
      return mock.browser(url);
    },
  });
  const acct = await plan.signIn();
  assert.notEqual(acct.id, "oaiapp_evil");
});
