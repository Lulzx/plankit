# Product

## plankit SDK (`/src`)

An MIT-licensed TypeScript library with no runtime dependencies, for Node 20 and later.

```js
import { createPlanClient } from "plankit";
const plan = createPlanClient({ appName: "My App" });
await plan.signIn();                       // browser sign-in, first-time registration
for await (const d of plan.streamText({ model, input: "Hi" })) process.stdout.write(d);
```

It handles:
- Sign-in through a local callback (`127.0.0.1`), PKCE, and first-time client registration
- A persistent host ID, plus multiple accounts and account switching
- ID-token verification against OpenAI's published keys (built on `node:crypto`)
- Token refresh that's safe across processes: one refresh even when many processes race
- Sign-out with revocation; the client registration is kept for the next sign-in
- Requests shaped for the plan-usage route: `store: false`, `stream: true`, unsupported fields stripped, `system` converted to `developer`
- Typed `PlanError` with a `recovery` hint (`sign_in`, `enable_plan`, `manage_usage`, `retry_later`, …), including usage limits that arrive mid-stream
- Credentials in an owner-only JSON file by default, or a custom store (for example, a keychain)

## CLI

`plankit login | status | models | ask "…" | use <id> | logout`. Piped input works: `cat notes.md | plankit ask "summarize"`.

## Folder Chat (`/examples/folder-chat`)

`npx folder-chat ~/notes` starts a local web app for chatting with a folder, running on your ChatGPT plan. It follows OpenAI's UI guidelines: a "Continue with ChatGPT" button, "Using ChatGPT plan · Manage usage" by the composer, a welcome modal on first sign-in, and a usage-limit modal. The server binds to `127.0.0.1` only and rejects foreign `Host` headers and cross-origin POSTs. It skips `.env*` files, hidden directories and `node_modules`.

## Tests

- `npm test` runs 17 end-to-end tests against a mock auth and API server (`test/mock-server.js`). They cover PKCE, rotation, concurrent refresh, mid-stream limits, nonce and state checks, and revocation.
- Folder Chat passed 12 HTTP checks against the same mock.
- **Not yet tested against a real ChatGPT account.**
