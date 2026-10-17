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

## Entitlement

This domain resolves **no** entitlement or plan verification of its own. Sign-in
proves the account authenticated; it does not prove the account has a ChatGPT
plan that covers this client, and login never asks. `login` returns credentials
and nothing else: no plan check, no tier lookup, no entitlement call. The account
id is read from the access token's own claim (`accountIdOf`), which is an
identifier, not a permission.

What the domain does verify is the **model catalog**, live, at
`https://chatgpt.com/backend-api/codex/models`, and treats it as the account's
answer to "what can I use".

> **Unverified.** The endpoint path and the response vocabulary (`slug`,
> `display_name`, `context_window`, `max_output_tokens`,
> `supported_reasoning_levels`, `default_reasoning_level`, `visibility`,
> `supported_in_api`) come from strings in the shipped `codex` CLI (0.163.0),
> **not** from an observed response. The exact JSON envelope is not pinned by
> those strings, so `parseCatalog` accepts the models at the top level, under
> `models`, or nested one level down. No live response has been seen. If the
> endpoint or shape differs, this degrades to the static catalog silently.

Behavior that holds regardless of that uncertainty:

- **Pi's static catalog is always the fallback.** Every failure — 401, 403, 404,
  429, 5xx, invalid JSON, an unrecognized envelope, an empty list, a network
  error — returns the full static `getModels("openai-codex")` list. `refreshModels`
  never throws. A wrong guess about the protocol cannot leave you with no models.
- **An empty catalog is treated as a failure**, not as "your plan has no models",
  because the second conclusion would discard a working static list.
- **Models the server omits are dropped**, not re-added from the static catalog.
  That is the point of discovery: a withdrawn model stops being offered.
- **Models the server adds are shown**, even when Pi's static catalog has never
  heard of them, with the server's limits.
- Limits come from the server. Pricing is inherited from Pi's static entry for
  the same slug, because a subscription is not billed per token and the live
  catalog carries no prices.
- Only reasoning levels the server actually reported are advertised.

So entitlement still ends where it ends for inference: Pi's inference layer
decides what is permitted, and a 403 from the backend is the first real signal.
The catalog narrows what is *offered*; it does not grant anything. Compare
[Antigravity](#entitlement), which does resolve a Cloud Code project and tier at
sign-in but likewise does not enforce them.

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
`slow_down`, cancellation, cleanup of the callback server, credential-safe errors,
and every catalog fallback path.

**Not verified:** a live sign-in, a live inference turn, entitlement for your plan,
the model catalog endpoint and its response shape (see
[Entitlement](#entitlement)), refresh at real expiry, and whether the `originator`
value (`pi`, as Pi's own Codex login sends) is accepted indefinitely. The endpoints
and parameters follow Pi's bundled Codex login and strings in the Codex CLI binary;
they are not a published third-party contract and may change.
