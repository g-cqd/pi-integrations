# Mistral Vibe Domain (`mistral-vibe`)

- **Provider ID:** `mistral-vibe`
- **Login Label:** **Mistral Vibe (experimental)**
- **Credential Type:** Browser PKCE approval exchanged for a Mistral API key
- **Models Offered:** the Vibe plan's `surface=vibe-code` catalog, at zero cost (usage is metered against the subscription, not per-token API credits):
  - `mistral-large-4` (**Mistral Large 4**, 1M context, reasoning + vision) — re-hosted from Pi's bundled Mistral catalog
  - `mistral-medium-latest` (**Mistral Medium 3.5**, 262K context, reasoning + vision) — re-hosted from Pi's bundled Mistral catalog
  - `zai-glm-5-3` (**GLM 5.3**, 1M context, reasoning) — declared inline (not in Pi's catalog)
  - `zai-glm-5-3-flash` (**GLM 5.3 Flash**, 1M context, reasoning + vision) — declared inline (not in Pi's catalog)

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
