# Codex domain

Provider ID: `codex-subscription`. Login label: **Codex Subscription (experimental)**.
Sign-in only: there is no API-key configuration.

## Which sign-in this is

This is the **Codex CLI's own ChatGPT sign-in** (its public client id), which
reaches the ChatGPT backend that Codex uses. It is **not** the "Sign in with
ChatGPT" token-sharing flow that Pi's `openai` provider offers (dynamic client
registration, tokens sent straight to `api.openai.com`). The two use different
clients, endpoints, and credentials, and can both be signed in at once. Pi also
ships a legacy `openai-codex` provider with the same protocol; this domain has
its own provider ID and credential, so neither replaces the other.

## Browser sign-in

1. Choose **Browser sign-in** at the method prompt (it is also the default when the
   host cannot show a prompt).
2. The domain binds a one-shot callback server on `127.0.0.1:1455` and shows
   the authorization link (PKCE S256, `redirect_uri=http://localhost:1455/auth/callback`).
3. After you approve, the browser redirects to the callback and sign-in finishes
   on its own. If your host provides `onManualCodeInput`, a pasted redirect URL
   can win the race instead.
4. If port 1455 is busy (the Codex CLI uses it too), the domain falls back to
   asking you to paste the full redirect URL. The pasted state must match; there is
   no bare-code shortcut.

The callback server accepts only `GET` on the exact path, requires a loopback
`Host` header (blocks DNS rebinding), ignores requests with a wrong state instead
of letting them cancel your login, accepts the first valid callback only, and
serves static pages that never echo the query string.

## Device-code sign-in

For headless machines: choose **Device code sign-in**, open
`https://auth.openai.com/codex/device`, and enter the one-time code. The domain
polls `.../api/accounts/deviceauth/token` for up to 15 minutes, honors
`slow_down` by lengthening the interval 5 seconds each time (RFC 8628), clamps a
server-supplied interval to 1 to 60 seconds, and then exchanges the returned
code. No port is bound and no browser link is shown.

## Credentials

Token endpoint: `https://auth.openai.com/oauth/token` (form-encoded). A credential
is the access token, a **rotating, single-use** refresh token, an expiry reduced by
the smaller of five minutes or 10% of the lifetime, and the ChatGPT account id.
The account id is read from the access token's `https://api.openai.com/auth`
claim and is required; a token without it is refused. The claim is read without
verifying the signature, which is fine because it only routes the request and the
server validates the token.

Errors expose only an allowlisted OAuth error code, never the provider's
description. Nothing is retried: a grant may already be consumed. Do not copy
tokens out of `~/.codex/auth.json`; sharing one refresh token between two clients
can invalidate the other (not tested here), so sign in separately.

## Inference

Pi's `openai-codex-responses` implementation and its 9-model Codex catalog are
reused unchanged. The streamer takes the account id from the access token it is
given. Prices shown are API list-price estimates; a ChatGPT subscription is not
billed per token. `bun run verify:pricing` checks them against OpenAI's page
(8 of 9 match; `gpt-5.3-codex-spark` has no official row), see [pricing](../pricing.md).

## What is and is not verified

Verified by tests (synthetic data, injected fetch and loopback): the authorization
URL parameters, PKCE binding, every pasted-input form and rejection, token
validation, the account-id requirement, refresh, the device flow including
`slow_down`, cancellation, cleanup of the callback server, and credential-safe errors.

**Not verified:** a live sign-in, a live inference turn, entitlement for your plan,
refresh at real expiry, and whether the `originator` value (`pi`, as Pi's own
Codex login sends) is accepted indefinitely. The endpoints and parameters follow
Pi's bundled Codex login and strings in the Codex CLI binary; they are not a
published third-party contract and may change.
