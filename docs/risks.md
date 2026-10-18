# Risks

| Risk | Likelihood | Response |
| --- | --- | --- |
| OpenAI relicenses the DevKit (MIT) or publishes it to npm | Medium | Still compete on no dependencies, the CLI and Python support, or fold into it and keep the example apps and audience |
| Plan-usage terms change or the beta closes | Medium | Keep a pluggable bring-your-own-API-key fallback; the SDK shape stays useful |
| Protocol details change during the preview | High | Pin behavior to the public docs; contract tests in the mock server make updates quick |
| Brand/trademark issues | Low | Use no OpenAI logos; use only the documented "Continue with ChatGPT" wording and follow the brand guidelines |
| No money from an MIT library | High | Revenue comes later: hosted features once commercial access opens (usage dashboards, team policies, API-key fallback billing) |
| Mobile not supported (loopback only) | Known | Desktop, CLI and self-hosted only for now |
| Credential theft from the local file | Low | Owner-only `0600` file, pluggable keychain store, revocation on sign-out |
