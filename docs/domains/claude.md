# Claude Subscription Domain (`claude-subscription`)

- **Provider ID:** `claude-subscription`
- **Login Label:** **Claude Subscription (experimental)**
- **Credential Type:** OAuth 2.0 PKCE (`S256`) with rotating single-use refresh tokens

---

## Sign-In Flow

1. Run `/login` and choose **Claude Subscription (experimental)**.
2. Open the displayed `https://claude.com/cai/oauth/authorize` URL in your browser.
3. Approve access and copy the full `code#state` string shown on the callback page.
4. Paste `code#state` into Pi. The domain verifies that `state` matches the active login attempt and exchanges the code at `https://platform.claude.com/v1/oauth/token`.

### Optional Environment Hints

| Variable | Effect |
| --- | --- |
| `CLAUDE_SUBSCRIPTION_ORG_UUID` | Pre-selects an organization UUID on the authorization URL |
| `CLAUDE_SUBSCRIPTION_LOGIN_HINT` | Pre-fills the account email hint on the authorization URL |

> [!NOTE]
> Requested scopes (`org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins`) match the official CLI's broad scope set and are not minimized. Review consent before proceeding.

---

## Subscription Inference Gate (`src/domains/claude/gate.ts`)

Subscription OAuth inference against `api.anthropic.com` (with an `sk-ant-oat` bearer token) is gated by a server-side classifier over the request's `system` parameter and `system`-role messages. Established by live bisection (2026-10-16), `applyClaudeCodeSystemGate` rewrites each outgoing payload before transport:

1. **Canonical First Block:** Reduces the top-level `system` parameter to the single canonical identity block required by the backend.
2. **System Prompt Relocation:** Moves all other system blocks into the first `user` message (preserving `cache_control` and unknown fields), placed immediately after any leading `tool_result` blocks required by the Anthropic Messages API.
3. **System-Role Absorption:** Absorbs any `role: "system"` messages in the conversation into an adjacent `user` message (inserting one if none exists).

The gate is **idempotent, non-mutating, and fail-safe**: it chains after any caller `onPayload` hook and never sends an un-gated request.

---

## Protocol-Drift Diagnostics (`src/domains/claude/diagnostics.ts`)

Because the backend classifier rules are undocumented and can evolve, HTTP `400`, `401`, `403`, and `429` rejections are enriched with a credential-safe diagnostic report:

- **Quota Evidence First:** An HTTP `429` with an explicitly `rejected` five-hour, weekly, model-weekly, or account quota is reported as a usage limit, not protocol drift, unless overage is explicitly allowed. The report shows valid reset timestamps in UTC, organization-disabled overage, and the request ID; it omits the drift checklist and request fingerprint. Structured diagnostics retain the raw quota evidence and add `classification: "usage_limit"`. Utilization alone does not prove exhaustion; missing or inconclusive headers retain the ambiguous report. This changes diagnostics, not the bundled SDK's retry policy.
- **Per-Status Interpretation:** Distinguishes classifier rejections (`400 "You're out of extra usage"`) from expired tokens (`401`), organization restrictions (`403`), and rate limits (`429`).
- **Rate-Limit & Trace Headers:** Captures `request-id` and all `anthropic-ratelimit-*` headers (noting when quota headers are absent).
- **Structural Request Fingerprint:** Reports model ID, message/tool counts, `max_tokens`, system block count, whether the canonical line matched, and surviving system-role count—without ever echoing tokens (`sk-ant-*`), prompt text, or tool names.
