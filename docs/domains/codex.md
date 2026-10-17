# Codex Subscription Domain (`codex-subscription`)

- **Provider ID:** `codex-subscription`
- **Login Label:** **Codex Subscription (experimental)**
- **Credential Type:** OAuth 2.0 PKCE (`S256`) with rotating refresh tokens + `chatgpt_account_id` JWT claim

---

## Overview

This domain implements the **Codex CLI's own ChatGPT sign-in** (`app_EMoamEEZ73f0CkXaXp7hrann`), reaching the ChatGPT Codex backend (`https://chatgpt.com/backend-api`). It is separate from Pi's `openai` token-sharing login and coexists with Pi's built-in providers without replacing them.

---

## Sign-In Methods

Run `/login` and choose **Codex Subscription (experimental)**:

### 1. Browser Sign-In (Default)
- Binds a one-shot callback server on `127.0.0.1:1455/auth/callback` and opens `https://auth.openai.com/oauth/authorize`.
- The loopback server accepts `GET` on the exact callback path only, enforces a loopback `Host` header (DNS-rebinding protection), ignores mismatched `state` requests without aborting your login, and closes immediately after the first valid callback.
- **Automatic Port-Collision Fallback:** If port `1455` is already in use (for example by a running Codex CLI), sign-in seamlessly falls back to prompting you to paste the final redirect URL (`http://localhost:1455/auth/callback?code=...&state=...`).

### 2. Device-Code Sign-In (Headless / SSH / Containers)
- Requests a one-time code from `https://auth.openai.com/api/accounts/deviceauth/usercode`.
- Open `https://auth.openai.com/codex/device` and enter the displayed code.
- Polls `/api/accounts/deviceauth/token` for up to 15 minutes, honoring RFC 8628 `slow_down` (+5s interval backoff), then exchanges the returned grant at `https://auth.openai.com/oauth/token`.

> [!WARNING]
> **Do not copy tokens out of `~/.codex/auth.json`.** Codex refresh tokens are rotating and single-use; sharing one refresh token across two clients will invalidate one of the sessions. Always sign in separately.

---

## Live Model Catalog & Static Fallback (`src/domains/codex/catalog.ts`)

When Pi refreshes model catalogs, `codex-subscription` queries `GET https://chatgpt.com/backend-api/codex/models` with your bearer token:

- **Live Discovery:** Parses the account's model slugs, display names, `context_window`, `max_output_tokens`, and `supported_reasoning_levels`, persists them via `context.publish({ persist })`, and drops models withdrawn from your account.
- **Guaranteed Fallback:** Every failure path (`401`, `403`, `404`, `429`, `5xx`, network error, or unrecognized JSON envelope) silently falls back to Pi's static `getModels("openai-codex")` catalog so a protocol change never leaves you without models.
- **Quota Integration:** The [Decision Router](decision-router.md) also probes `GET https://chatgpt.com/backend-api/codex/usage` to read your 5-hour (`primary_window`) and 7-day (`secondary_window`) utilization and per-model availability (`model_usage`).
