# Protocol notes

A condensed summary of OpenAI's public docs, as implemented in plankit. Source: <https://developers.openai.com/siwc/token-sharing-open-source>.

| Step | Detail |
| --- | --- |
| Host ID | Persist one per install: `urn:uuid:<v4>` (JWK thumbprint and `did:key` also accepted) |
| Authorize | `GET https://auth.openai.com/api/accounts/authorize` in the system browser |
| First sign-in | `client_id=dynamic_agent_client` + `agent_name_hint` + `ext_agent_host_id`; the callback returns the issued `client_id` (`oaiapp_…`) |
| Later sign-ins | Saved `client_id`, `id_token_hint`, `login_hint`; no `agent_name_hint` |
| Redirect | `http://127.0.0.1:<port>/auth/callback`; only the port may vary, and never `localhost` |
| Scopes | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| Resource | `https://api.openai.com/v1` on authorize, exchange and refresh |
| Token | `POST https://auth.openai.com/api/accounts/oauth/token` (form), no secret |
| Plan check | The granted scopes must include `chatgpt.tokens.use.direct` |
| Refresh | `grant_type=refresh_token`, no `scope`; tokens rotate, so serialize refreshes |
| Revoke | `revocation_endpoint` from OIDC discovery, `token_type_hint=refresh_token` |
| Models | `GET /v1/models` → `models[]` filtered to `visibility == "list"` |
| Inference | `POST /v1/responses`, `store:false`, `stream:true`; success only on `response.completed` |
| Usage limit | `subscription_sharing_usage_limit_exceeded` (429, or mid-stream `response.failed`) → link to chatgpt.com/settings/usage |
| Re-consent | `prompt=consent` (`force_reconsent=true` only once OpenAI enables it for your integration) |
