# Mistral/Vibe domain

Provider ID: `mistral-vibe`. Login label: **Mistral Vibe (experimental)**.
The separate ID leaves Pi's built-in `mistral` provider/configuration intact.

This is a full Pi browser-login integration, **not a Keychain helper** and not
an invocation of the Vibe CLI.

## Browser flow

1. Generate fresh PKCE S256 material.
2. POST `https://console.mistral.ai/api/vibe/sign-in` with the challenge.
3. Validate process ID, future expiry, browser origin, and poll origin/path.
4. Display the browser URL and poll the returned URL.
5. On completed, POST `/vibe/sign-in/<process>/exchange` with the exchange token
   and verifier.
6. Validate and return the API key for Pi storage.

Denied, expired, error, unknown, missing-token, and malformed-key responses fail
without automatically retrying the exchange. HTTP 410 is treated as expiration.
The total flow is capped at the earlier of the returned expiry or ten minutes.

**The service returns an API key, not an OAuth access/refresh-token pair.**
Pi's OAuth compatibility UI/storage interface hosts the flow; the refresh field
is empty and the refresh callback retains the API key. Its distant timestamp is
bookkeeping, not a provider-issued key lifetime. Re-login may create another key;
manage/revoke keys through Mistral's supported account controls.

There is no API-key configuration: browser sign-in is the only credential path.
The domain does not read Vibe's Keychain, environment file, or session state.
The old personal Keychain bridge is not included.

## Source and limits of evidence

Protocol reference: Mistral's public Vibe repository at revision
[`4ae5c5955da8e761318916bdb1a7f46f0b50c7d0`](https://github.com/mistralai/mistral-vibe/tree/4ae5c5955da8e761318916bdb1a7f46f0b50c7d0):

- [browser flow](https://github.com/mistralai/mistral-vibe/blob/4ae5c5955da8e761318916bdb1a7f46f0b50c7d0/vibe/setup/auth/browser_sign_in.py)
- [HTTP gateway](https://github.com/mistralai/mistral-vibe/blob/4ae5c5955da8e761318916bdb1a7f46f0b50c7d0/vibe/setup/auth/http_browser_sign_in_gateway.py)
- [default endpoints](https://github.com/mistralai/mistral-vibe/blob/4ae5c5955da8e761318916bdb1a7f46f0b50c7d0/vibe/core/config/_defaults.py)

This is protocol adaptation based on source, not a claim of byte-identical
behavior or a published compatibility guarantee. Unlike that source's bounded
transient poll retries, this version fails immediately on a poll transport error.

The domain offers exactly one model, **Mistral Large 4** (`mistral-large-4`, verified
against Mistral's price page; see [pricing](../pricing.md)). It fails loudly at
registration if Pi's catalog stops carrying it, rather than offering another model.
Inference delegates to Pi's **Mistral Conversations** implementation (which posts to
`/v1/chat/completions`, the endpoint Vibe's own SDK client uses). That is not a reimplementation of Vibe's inference client.
API-key eligibility for those models/endpoints, live login/inference, and Vibe
subscription billing have **not** been verified. Source availability alone does
not establish third-party access permission or subscription entitlement.
