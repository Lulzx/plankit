# Competition

## OpenAI's official DevKit

[openai/sign-in-with-chatgpt-devkit](https://github.com/openai/sign-in-with-chatgpt-devkit) ships a Node SDK (`@siwc/local`), React components, design assets and an example macOS app (Paste Perfect). It's good, and it's the reference implementation.

## The gap it leaves

| | Official DevKit | plankit |
| --- | --- | --- |
| License | Noncommercial; modifications must stay under the same license | MIT |
| Usable in MIT/Apache projects | No: the noncommercial terms conflict with OSI licenses | Yes |
| On npm | No (`private: true`, a workspace you clone) | Yes, `npm i plankit` |
| Runtime dependencies | `jose`, `openai`, `proper-lockfile` | None |
| Languages | Node | Node (Python planned) |
| CLI | No | `plankit login / ask / status` |

The license is the main wedge. The DevKit license excludes use "by or for a business… whether or not a fee is currently charged". Many open-source maintainers either can't accept that or don't want to.

## Clean-room rule

plankit is written only from OpenAI's **public protocol docs**. We do not read, copy or port DevKit source. Keep it that way so the MIT license stays defensible.

## Other players

- Larger open-source apps (OpenClaw, OpenCode, T3) built their own integrations in-house. They're potential users of a shared library, not competitors.
- Paid-MCP and x402 marketplaces solve a different problem: paying for tools, not for inference.
