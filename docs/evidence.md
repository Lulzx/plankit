# Evidence

Verified on 2026-10-18. Secondary sources are marked; treat them as directional.

## Primary (OpenAI)

- Plan usage is available to "open-source projects, personal projects that run locally, and selected private apps"; commercial apps go through an interest form. ([Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), [Overview](https://developers.openai.com/siwc/token-sharing-open-source))
- The flow needs no client secret or partner API key; the client is registered dynamically during the first sign-in. ([Sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in))
- Access tokens last 1 hour; refresh tokens last 30 days and rotate on each refresh. ([Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference))
- Users set a per-app weekly cap in ChatGPT settings. For Plus users, the 5-hour limit is shared across all apps. ([Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions))
- Inference must use `POST /v1/responses` with `store: false` and `stream: true`. Several fields and hosted tools aren't supported. ([Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations))
- The official DevKit is under a **noncommercial** license and is not on npm (`npm view @siwc/local` → 404, `"private": true`). ([Repo](https://github.com/openai/sign-in-with-chatgpt-devkit))

## Secondary

- DevDay 2026 recap: plan usage launched with 16 partners; ChatGPT reaches about 1.2B weekly users. ([emergent.sh](https://emergent.sh/news/openai-devday-2026))
- Partner list with only 4 open-source apps. ([eesel](https://www.eesel.ai/blog/sign-in-with-chatgpt), [Codex Workshop](https://www.codexworkshop.com/research/sign-in-with-chatgpt-use-your-plan-in-dev-tools))
- Demand signals: GitHub issues asking to add it. ([notelore #103](https://github.com/mfozmen/notelore/issues/103), [meta-coder #37](https://github.com/shaheedazaad/meta-coder/issues/37))
