# Mistral Vibe Domain (`mistral-vibe`)

- **Provider ID:** `mistral-vibe`
- **Login Label:** **Mistral Vibe (experimental)**
- **Credential Type:** Browser PKCE approval exchanged for a Mistral API key
- **Models Offered:** Pi's whole Mistral catalog (37 models as of pi-ai 1.4.0), including `mistral-large-4` (**Mistral Large 4**, 1M context, reasoning + vision) and the `zai-glm-5-*` / `glm-5-2` reasoning models. The key is a standard Mistral API key, not scoped to one model: a Vibe-issued key answered `zai-glm-5-3` on `/v1/chat/completions` (probed 2026-10-27).

---

## Sign-In Flow

Adapted from Mistral's public Vibe CLI source (`4ae5c5955da8e761318916bdb1a7f46f0b50c7d0`):

1. Generates a fresh PKCE `S256` verifier and challenge.
2. Calls `POST https://console.mistral.ai/api/vibe/sign-in` with the challenge.
3. Validates the returned `process_id`, future `expires_at` timestamp, and Console origin/path boundaries (`trustedUrl`).
4. Displays the browser sign-in URL and polls `poll_url` every 3 seconds (capped at 10 minutes).
5. On `status === "completed"`, exchanges `exchange_token` + `code_verifier` at `POST /api/vibe/sign-in/<process_id>/exchange` and stores the returned `api_key`.

> [!NOTE]
> The service issues a standard Mistral API key rather than an OAuth refresh token pair. Manage or revoke keys in the Mistral Console. This domain never reads Vibe's local Keychain or configuration files.
