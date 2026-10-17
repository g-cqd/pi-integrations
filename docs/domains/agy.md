# Antigravity (`agy`) Subscription Domain (`agy-subscription`)

- **Provider ID:** `agy-subscription`
- **Login Label:** **Antigravity Subscription (experimental)**
- **Credential Type:** Google Desktop OAuth 2.0 PKCE (`S256`) + Cloud Code Project (`projectId`) & Tier (`tierId`)

---

## Zero-Step Client-Secret Discovery (`src/domains/agy/secret-resolver.ts`)

Google's token endpoint requires the Antigravity Desktop app's OAuth client secret (`GOCSPX-...`). **The secret is never bundled in this repository.** Instead, before sign-in or token refresh, the domain resolves it automatically in this order:

1. `AGY_OAUTH_CLIENT_SECRET` environment variable (if set).
2. `AGY_OAUTH_CLIENT_SECRET_FILE` or `~/.config/pi-integrations/agy-oauth-client-secret` (if present).
3. **Automatic Local Binary Discovery:** Locates your installed `agy` (or `antigravity`) binary across `$AGY_BINARY`, `$PATH`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, and the Homebrew Caskroom, slices candidate `GOCSPX-` strings to their exact 35-byte window (avoiding glued adjacent strings in the binary's string table), verifies each candidate against `https://oauth2.googleapis.com/token` (`invalid_grant` = valid client secret, `invalid_client` = decoy), and caches the verified secret **in memory only**.

An optional standalone operator command is also available if you want to verify or persist the secret manually:

```sh
bun run agy:extract-secret -- --check   # verify only, write nothing
bun run agy:extract-secret              # verify and write mode 600 to ~/.config/pi-integrations/agy-oauth-client-secret
```

---

## Sign-In & Cloud Code Onboarding

1. Run `/login` and select **Antigravity Subscription (experimental)**.
2. Open the displayed Google OAuth link (`redirect_uri=https://antigravity.google/oauth-callback`), sign in, and paste the authorization code shown on the final page into Pi.
3. After exchanging the code, the domain calls `POST /v1internal:loadCodeAssist` (`mode: "FULL_ELIGIBILITY_CHECK"`) to resolve your Cloud Code `projectId` (e.g. `aicode-consumers`) and `tierId`.
4. If your Google account has never completed Antigravity onboarding, sign in once in the official `agy` CLI to provision the consumer project, then run `/login` in Pi again.

---

## Live Model Catalog & Custom `cloudcode-pa` Streamer

### Live Catalog (`v1internal:fetchAvailableModels`)
- Reads your account's live **Recommended** model group (`gemini-4-argon-medium/high/low`, `gemini-3.8-flash-high/medium/low`, `claude-opus-5-5-low/medium/high`, `claude-sonnet-5-5-low/medium/high`, `gpt-oss-120b-medium`, with `defaultAgentModelId` sorted first) plus any extra entries in `tieredModelIds` (`gemini-3.5-flash-lite`, `gemini-3.8-flash-tiered`).
- Persists the catalog via `context.publish({ persist })` so models survive Pi restarts offline.

### Custom Inference Stream (`src/domains/agy/stream.ts`)
Because Pi's built-in Google adapter drives `@google/genai` and rejects a custom `fetch`, this domain builds the standard Gemini request using Pi's exported helpers (`convertMessages`, `convertTools`), wraps it in the `v1internal` envelope, and streams `POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` directly (override host with `AGY_API_URL`).

---

## Verified Protocol Findings (2026-10-17)

| Finding | Evidence Source |
| --- | --- |
| **Three-Level `User-Agent` Gate** | Live bisection with one token and account: `loadCodeAssist` accepts any UA containing `antigravity`, but `fetchAvailableModels` (full 29-model catalog with `gemini-4-argon-*` vs. reduced 23-model catalog) and `streamGenerateContent` (HTTP 200 vs. 404 on `gemini-4-argon-*`) gate on the exact prefix `antigravity/cli/<version>`. `USER_AGENT` therefore sends `antigravity/cli/1.4.0 pi-integrations/0.1.0 (agy-subscription)`. |
| **Adjacent Secret Strings in Binary** | Disassembly of `agy` 1.4.0 (`mov x10, #0x23`) showed two 35-byte `GOCSPX-` strings stored back-to-back with no delimiter at `0x335a38c`; greedy regex matching glues them into an invalid 70-byte string. |
| **Quota Summary Endpoint** | `POST /v1internal:retrieveUserQuotaSummary` returns `5h` and `weekly` `remainingFraction` buckets used by the [Decision Router](decision-router.md). |
