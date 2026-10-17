# Spettro Subscription Domain (`spettro`)

- **Provider ID:** `spettro`
- **Login Label:** **Spettro Subscription**
- **Credential Type:** Browser device-session approval returning a device API key

---

## Sign-In Flow

1. Run `/login` and choose **Spettro Subscription**.
2. The domain posts a fresh session UUID to `POST https://api.spettro.app/auth/initiate` (override base URL with `SPETTRO_API_URL`).
3. Open the returned HTTPS browser link and approve the device session.
4. Pi polls `GET /auth/poll/<session>` (bounded to 10 minutes overall, 30 seconds per request) until `pending` transitions to `complete`, then stores the issued device key.

---

## Live Model Discovery & Persistence

- **Catalog Refresh:** Queries authenticated `GET /v1/models`, deduplicates model IDs, extracts boolean `vision` and `reasoning` flags and integer `context_window` limits, and persists the resulting catalog via `context.publish({ persist })`.
- **Offline & Unconfigured Guard:** When offline or before sign-in, `refreshModels` restores from `context.stored` or returns the non-sendable `spettro-catalog-loading` placeholder so the provider remains discoverable without inventing models.
- **Classic System-Role Compatibility:** Models set `compat: { supportsDeveloperRole: false }` for backend compatibility and delegate streaming to Pi's `openAICompletionsApi`.
