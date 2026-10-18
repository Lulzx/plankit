# Roadmap

## v0.1 (built)
SDK, CLI and the Folder Chat example, tested against a mock server.

## Next
- Test against a real ChatGPT account and fix anything the mock misses
- npm publish; GitHub Actions CI on macOS, Linux and Windows
- Keychain store (macOS Keychain / libsecret / Windows Credential Manager) as an optional add-on

## v0.2
- **Python package** (`pip install plankit`). Many local open-source tools are in Python, and there's no official Python kit
- React hooks and components (`usePlan()`, sign-in button, usage-limit modal)
- Tauri/Rust and Electron recipes

## v0.3
- Integration PRs to open-source projects that requested plan usage
- A "Works with your ChatGPT plan" directory site

## Once commercial access opens
- Hosted dashboard: per-app usage, team policies, fallback to an API key when the plan runs out
