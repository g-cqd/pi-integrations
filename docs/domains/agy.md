# Antigravity (`agy`) domain

Provider ID: `agy-subscription`. Login label: **Antigravity Subscription (experimental)**.
Sign-in only: there is no API-key configuration.

**Setup:** one input. The Antigravity app's OAuth client secret is **not** in
this repository; supply it from the environment or a local file first (see
[the client secret](#the-client-secret)).

## Sign-in

The flow is the one the shipped `agy` CLI uses for its **Google OAuth** method. Its
authorization link was captured from the CLI itself, in an isolated profile that
never signed in, and the URL builder is pinned to it by a test:

- `https://accounts.google.com/o/oauth2/auth` with `access_type=offline`,
  `prompt=consent`, PKCE S256, the Desktop client
  `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`,
  and scopes `cloud-platform userinfo.email userinfo.profile cclog
  experimentsandconfigs aicode openid`.
- `redirect_uri=https://antigravity.google/oauth-callback`, a hosted page that shows
  the authorization code for you to **paste into Pi**. No local port is used.
- Exchange at `https://oauth2.googleapis.com/token`, which requires the client secret.

After the exchange the domain calls `v1internal:loadCodeAssist` to find your Cloud
Code project and tier and stores the project with the credential, because inference
requests must carry it. If the account has no project, sign-in stops with guidance
to finish onboarding once in the `agy` CLI. Refresh keeps the project; Google normally
keeps the refresh token, and a rotated one is adopted when sent.

The CLI's other method, "Use a Google Cloud project", is **not implemented**. Google's
device-code flow does not work for this client (it answers `invalid_client`).

## Entitlement

Unlike [Codex](../codex.md#entitlement), this domain does resolve entitlement at
sign-in. `login` calls `loadCodeAssist` with `FULL_ELIGIBILITY_CHECK` and stores
`projectId` and, when the server reports one, `tierId` with the credential,
because inference requests must carry the project. An account with no project
fails sign-in with the server's `ineligibleTiers` reason codes rather than
discovering it at first use.

`refreshModels` then reads the **account's** model list live and sorts the
server's `defaultAgentModelId` first, so what you see reflects your tier rather
than a static catalog. Two limits are honest:

- Tier is recorded but never enforced. `tierId` is stored for diagnostics; nothing
  compares it against what a model requires, because the server does not publish
  per-tier model requirements. A 403 at inference is still the real signal, and
  `describeFailure` reports it as tier, onboarding, or client identity.
- The project and tier come from one call at sign-in. They are kept on refresh,
  not re-verified, so a downgrade or a revoked project is not noticed until a
  request fails.

## The client secret

Google's token endpoint refuses this Desktop client without its secret: an anonymous
probe answers `client_secret is missing`. The secret ships inside the closed-source
`agy` binary, so it is a credential of the Antigravity **app**, not of any user.

**It is not bundled in this repository**, in any encoding. Supply it at run time,
resolved in this order (blank counts as unset):

1. `AGY_OAUTH_CLIENT_SECRET` (environment variable).
2. `AGY_OAUTH_CLIENT_SECRET_FILE`, or by default
   `~/.config/pi-integrations/agy-oauth-client-secret` (a file whose trimmed content
   is the secret). `~` is expanded.

```sh
# once per machine, outside any repository
install -d -m 700 ~/.config/pi-integrations
printf '%s' "$SECRET" > ~/.config/pi-integrations/agy-oauth-client-secret
chmod 600 ~/.config/pi-integrations/agy-oauth-client-secret
```

To read it from your own installation, use the extractor. It locates candidates in
the `agy` binary, verifies each against the token endpoint, and writes the accepted
one to the run-time path above with mode 600:

```sh
bun run agy:extract-secret            # defaults to the agy on PATH
bun run agy:extract-secret -- --check # verify only, write nothing
```

Nothing is trusted on shape alone. Two details make a hand-rolled search unreliable,
and the extractor exists because of them:

- **Greedy matches are wrong.** Google secrets sit in the binary's string table as
  adjacent fixed-width strings with no separator, so
  `strings agy | grep -o 'GOCSPX-[A-Za-z0-9_-]*'` runs two secrets together and yields
  a value that does not exist in the file. The true secret is 35 bytes; the greedy
  result is not a candidate at all. The extractor slices to each plausible length
  and applies an upper bound, so a slice running into the next secret is rejected.
- **Offsets do not survive a rebuild.** Any recorded address is valid for exactly one
  build. The extractor searches for content and never persists a location, so an app
  update changes nothing unless Google rotates the secret.

Candidates are confirmed by the token endpoint with a deliberately bogus code:
`invalid_grant` means Google accepted the client credentials and rejected only the
code, while a wrong value answers `invalid_client`. So a neighbouring secret or a
decoy is discarded rather than configured, and no inconclusive response is treated as
a pass. The secret is sent only in a POST body, never argv, so it stays out of the
process table and shell history, and it is never echoed. Keep the value out of logs
and out of this repository. Sign-in checks for the secret **before** opening a browser
link and fails with these instructions if it is missing or malformed.

If the extractor reports that no candidate was accepted, the installed `agy` is using
a rotated or different client secret; update `agy` and re-run it rather than
substituting a guess. The search rules are pure and unit-tested in
`test/agy/extract-candidates.test.ts`; only the script itself talks to Google, which
is why it is outside `bun test` and `scripts/ci.sh`.

The secret is never stored in credentials, never logged, and never echoed in errors
(tests assert all three). Google's documentation says an installed application's
secret is not treated as confidential, which is why this is an app credential rather
than a user credential, but redistributing one is still your call; see [terms](#terms).

## Models

The catalog is read live from your account (`v1internal:fetchAvailableModels`) when
Pi refreshes models, using the server's own agent-model groups, display names, image
and thinking flags, and limits. Until then a placeholder that cannot be sent is shown.
When the server reports no limit, a context of 128000 and an output of 8192 are used;
those are **not** verified limits. Costs are zero meaning unknown, since a
subscription is not billed per token. The reasoning variant (for example `-low` or
`-high`) is part of the model id, so Pi's reasoning level is not forwarded; only
thought parts are requested.

## Inference

Pi's built-in Google adapter cannot be used: it drives the `@google/genai` SDK and
rejects a custom `fetch`. This domain therefore:

1. builds the standard Gemini request with Pi's own exported helpers
   (`convertMessages`, `convertTools`, stop-reason and thought-signature helpers);
2. wraps it in the `v1internal` envelope
   `{project, requestId, model, userAgent, requestType, userPromptId, request}`;
3. streams `POST /v1internal:streamGenerateContent?alt=sse` with a bounded SSE
   reader and unwraps each `response`;
4. assembles Pi events with the same semantics as the built-in adapter: text and
   thinking blocks, tool calls with signatures, usage, and stop reasons.

The default host is `https://daily-cloudcode-pa.googleapis.com`, the one the shipped
CLI actually calls. Set `AGY_API_URL=https://cloudcode-pa.googleapis.com` to use the
production host constant also present in the binary. No request is retried.

## Failures

Because live behavior is unverified, every rejection is described rather than
swallowed: HTTP status, a hint, Google's status code, a redacted truncated message,
the request or trace id, and `retry-after`. Access tokens, refresh tokens, and the
client secret are redacted from provider messages.

## Evidence and its limits

| Fact | Source |
| --- | --- |
| Authorization URL, hosted paste page | captured from the CLI (isolated profile, no sign-in) |
| Token endpoint needs the secret; Desktop client; no device flow | anonymous probes of Google's endpoints |
| Envelope, project lookup, and model-list schemas | protobuf descriptors embedded in the binary |
| Endpoint paths and the daily host | the CLI's own request log of one real turn |
| Backend accepts `parametersJsonSchema`, thought parts, function-call ids | same descriptors |
| **Backend gates the account's project on the User-Agent naming the Antigravity client** | live bisection (2026-10-17): same token, same account — `antigravity-1.4.0` in the UA receives `aicode-consumers`; `pi-integrations/…` alone receives `ineligibleTiers: [UNSUPPORTED_CLIENT]`. The metadata fields (`ideName`, versions) are not checked. |
| **`streamGenerateContent` accepts this package's envelope verbatim** | live turn (2026-10-17): `claude-opus-5-5-low` and the tiered base id both answered 200 and produced output through this domain's own streamer. |
| **Tiered models are offered under their BASE id, not the CLI's expanded display ids** | bisected live: `gemini-3.8-flash-tiered` → 200 with this package's plain envelope; `gemini-3.8-flash-medium` → 404 even with the CLI's own `labels` and `sessionId` reproduced. The expanded ids work only for the registered CLI client. `gemini-4-argon` does not appear in the account's catalog response at all (it lives in the CLI's embedded catalog or behind its feature flags) and is therefore not offered. |
| **Catalog refresh must publish, not return** | Pi persists only what `refreshModels` passes to `context.publish({ persist })`; the return value alone updates memory for the session. Observed in Pi's composer and runtime; fixed in all three catalog domains (agy, codex, spettro). |

Because of that finding, `USER_AGENT` leads with `antigravity-<version>` (the value
the gate matches) and keeps this package's own identity after it. This is a
first-party identity claim required for the account's own project to be returned —
the same category of decision as the Claude gate, documented here rather than hidden.

**Not verified:** that Google accepts this client's token exchange and refresh with
the secret; refresh at real expiry; quota behavior; and the daily versus production
host. (The stream itself IS verified live now, for one turn on two model ids:
a recommended model and a tiered base id.) The tests exercise all of this against synthetic data and
Pi's real conversion helpers only.

## Terms

This uses a first-party client identity outside its own application, the same
category of risk as the Claude subscription gate and the Codex client. Google's
current terms for it have not been verified here. Read them before signing in.
