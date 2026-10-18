# plankit

Let users power your open-source, local app with **their own ChatGPT plan**. You need no API key and pay no inference bill. MIT-licensed, with no runtime dependencies.

```sh
npm i plankit
```

```js
import { createPlanClient, PlanError } from "plankit";

const plan = createPlanClient({ appName: "My App" });
await plan.signIn(); // opens the browser: "Continue with ChatGPT"

const [model] = await plan.models();
for await (const delta of plan.streamText({ model: model.slug, input: "Hello!" })) {
  process.stdout.write(delta);
}
```

Errors are typed, so the app knows what to do next:

```js
try { await plan.text({ model, input }); }
catch (e) {
  if (e instanceof PlanError && e.recovery === "manage_usage") showLimitModal(e.manageUsageUrl);
}
```

## CLI

```sh
npx plankit login
npx plankit ask "Explain PKCE in one paragraph"
cat notes.md | npx plankit ask "Summarize"
```

## Example: Folder Chat

```sh
cd examples/folder-chat && npm install && node server.js ~/notes
```

## Eligibility

ChatGPT plan usage is currently open to **open-source projects and apps that run locally**. Commercial or hosted apps need OpenAI approval ([interest form](https://openai.com/form/sign-in-with-chatgpt-interest/)). Follow OpenAI's [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) and brand guidelines in your app.

plankit is an independent project, not affiliated with OpenAI. It is a clean-room implementation of the [public protocol docs](https://developers.openai.com/siwc/token-sharing-open-source).

## Docs

- [Opportunity](docs/opportunity.md): why this exists now
- [Evidence](docs/evidence.md): what we verified, with sources
- [Competition](docs/competition.md): the official DevKit and the license gap
- [Product](docs/product.md): SDK, CLI, example app, tests
- [Protocol notes](docs/protocol.md): the flow as implemented
- [Risks](docs/risks.md)
- [Roadmap](docs/roadmap.md)

## Development

```sh
npm install
npm test   # builds, then runs end-to-end tests against a local mock of the auth and API servers
```

MIT License
