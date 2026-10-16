# Investigation: Codex and Antigravity (`agy`) subscription sign-in

Dates: 2026-10-17. Tools: Codex CLI 0.163.0, `agy` 1.4.0, Pi 1.3.0.
**Outcome:** both are now domains in this package, see [Codex](../domains/codex.md)
and [Antigravity](../domains/agy.md). This note records how the protocols were
established and which routes did not work.

Method: read-only. No account login was completed and no token store or keychain
secret was read. The only authenticated action was one trivial `agy` turn on the
cheapest model to read its request log.

## Codex

- Pi 1.3.0 already has two ChatGPT logins: a legacy `openai-codex` provider (the Codex
  CLI client) and "Sign in with ChatGPT" token sharing on the `openai` provider. The
  domain here deliberately follows the **Codex CLI client** route, not token sharing.
- Protocol (from Pi's bundled flow and the Codex binary): authorization code with PKCE
  (loopback `:1455` or pasted redirect) or device code, form-encoded token exchange and
  refresh at `https://auth.openai.com/oauth/token`, and the account id read from the
  access token's `https://api.openai.com/auth` claim.
- Inference reuses Pi's `openai-codex-responses` streamer.

## Antigravity: what the evidence showed

| Step | Finding | How |
| --- | --- | --- |
| Sign-in methods | "Google OAuth" and "Use a Google Cloud project" | `agy` run in an isolated, empty HOME with a no-op `open` shim; sign-in never completed |
| Google OAuth link | `accounts.google.com/o/oauth2/auth`, Desktop client `1071006060591-…`, 7 scopes, `prompt=consent`, hosted redirect `https://antigravity.google/oauth-callback` | printed by the CLI itself |
| Callback | the hosted page displays the code to **paste into the app** | read the page |
| Token step | `client_secret is missing` for both embedded clients | anonymous bogus-code probe |
| Device code | `invalid_client` for both clients | anonymous probe |
| Inference host | `https://daily-cloudcode-pa.googleapis.com` (`loadCodeAssist`, `fetchAvailableModels`, `streamGenerateContent?alt=sse`) | the CLI's request log |
| Request schemas | `v1internal` envelope, project lookup, model list | protobuf descriptors decoded from the binary |

### Dead ends (do not repeat)

- **Client ID Metadata Document** at `https://antigravity.google/oauth/client-metadata.json`
  (public client, `token_endpoint_auth_method: none`) with `auth.cloud.google` and the
  STS token endpoint looked like a secret-free route. It is not usable here: the STS
  endpoint validates the *code* before the client (any client id, even `not-a-url`, gets
  `invalid_grant`), so that probe proved nothing, and `auth.cloud.google/authorize`
  returned `invalid_client` for the published id and `invalid_scope` for every scope set
  tried against the other client. The CLI's "Use a Google Cloud project" method is the
  likely user of that server; it is not implemented.
- **Transparent TLS interception** to read request bodies: Go on macOS ignores
  `SSL_CERT_FILE`, so it would have required changing the system trust store. Not done.
  Schemas were recovered from the embedded descriptors instead.
- **Reusing Pi's Google adapter** for inference: it rejects a custom `fetch`.

### Consequence

The token step needs the app's client secret, which exists only inside the closed-source
binary. It is supplied at run time, never committed. The binary holds two `GOCSPX-`
strings (both earlier printed to a terminal by an unredacted command); testing each
against the token endpoint with a bogus code showed exactly one pairs with this client
(`invalid_grant` versus `invalid_client`). That test is how you identify the right
value from your own install.

## Still unverified

A live sign-in, token exchange and refresh with the secret, `cloudcode-pa` acceptance of
this client's identity and headers, real stream chunks, quota behavior, and Google's
terms for this use. See the Antigravity doc for the list.
