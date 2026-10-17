# Security Policy

`pi-integrations` is experimental software, not an audited authentication client.

## Reporting a Vulnerability

Please use **[GitHub Private Vulnerability Reporting](https://github.com/g-cqd/pi-integrations/security/advisories/new)**.

- **Do not** open public issues or pull requests containing live credentials, OAuth authorization codes, refresh tokens, private account identifiers, raw proxy captures, or unredacted provider error bodies.
- Include the affected commit revision, expected vs. observed behavior, and a minimal reproduction using synthetic data.

---

## Security Boundaries & Guarantees

### 1. Transport & Cancellation Hardening (`src/shared/http.ts`, `src/shared/sse.ts`)
- **No Redirects on Credentialed Calls:** Every request sets `redirect: "error"` so bearer tokens and OAuth grants are never forwarded across HTTP redirects.
- **Signal-Raced Body Reads:** Both the 30-second request timeout and caller `AbortSignal` race every chunk read (`Promise.race([reader.read(), abortRace])`), preventing a peer that sends headers and stalls the body from pinning the process indefinitely.
- **Bounded Memory:** One-shot HTTP responses are capped at **1 MiB** (`RESPONSE_LIMIT_BYTES`), and SSE streams are capped at **4 MiB per event** (`SSE_MAX_EVENT_BYTES`).
- **No Automatic Retries on Grants:** Single-use authorization codes and rotating refresh tokens are never retried automatically on transport failure.

### 2. Loopback & URL Validation (`src/shared/loopback.ts`, `src/shared/urls.ts`)
- **Loopback Callback Server (Codex):** Binds `127.0.0.1:1455` for one login attempt, serves `GET` on the exact callback path only, enforces a loopback `Host` header (blocking DNS rebinding), ignores requests with mismatched `state` so stray requests cannot cancel an active login, and serves static HTML that never reflects query parameters.
- **Origin & HTTPS Pinning:** `safeBaseUrl` requires HTTPS (or explicit loopback HTTP for local development) and rejects embedded credentials, queries, or fragments. `trustedUrl` pins Mistral/Vibe browser and polling URLs to the Console origin and path prefix.

### 3. Antigravity (`agy`) Client Secret Handling
- **Never Bundled in Any Encoding:** The Antigravity desktop OAuth client secret is an application credential embedded in Google's `agy` binary. It is never committed to this repository.
- **Multi-Encoding Repository Guard:** `test/agy/no-bundled-secret.test.ts` scans all source, config, and documentation files in raw text, reversed text, concatenated string literals, and decoded `base64`, `base64url`, and `hex` spans, with a canary test proving every decoder fires.
- **In-Memory Runtime Discovery:** When `AGY_OAUTH_CLIENT_SECRET` and `~/.config/pi-integrations/agy-oauth-client-secret` are unset, `src/domains/agy/secret-resolver.ts` reads the local `agy` binary bytes (never executing the binary), verifies candidates against Google's token endpoint, and caches the accepted secret in memory only.
- **Token Redaction:** Provider error formatters in Antigravity, Codex, and Claude strip `ya29.`, `1//`, `GOCSPX-`, `sk-ant-`, and `Bearer` token shapes before surfacing diagnostics.

### 4. Local Execution & Credential Persistence
- **OS Permissions:** Pi extensions and the compiled Apple Foundation Models Swift bridge (`~/.cache/pi-integrations/apple-foundation/apple-fm-bridge-v2`) run with the user's operating-system permissions.
- **Plaintext Storage:** Pi stores credentials in `~/.pi/agent/auth.json`. Running `/logout` removes the local entry from Pi but does not prove server-side token revocation; revoke exposed tokens in your provider's account settings.
