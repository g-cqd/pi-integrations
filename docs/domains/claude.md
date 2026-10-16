# Claude domain

Provider ID: `claude-subscription`. Login label: **Claude Subscription (experimental)**.

Uses browser authorization with PKCE S256, a mandatory matching state in the
pasted response, JSON code exchange, and rotating refresh credentials.
Authorization: `https://claude.com/cai/oauth/authorize`.
Exchange/refresh: `https://platform.claude.com/v1/oauth/token`.
The code-level revoke helper targets that endpoint's `/revoke` path; Pi logout
does not invoke it.

Constants originated in a local investigation of Claude Code 2.1.301, not a
published third-party OAuth contract. The public client ID belongs to the
existing application, not an app separately registered for this project.

Requested permissions are broad and **not minimized**:

```text
org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins
```

Review consent before proceeding. The adapter validates returned scope as a
string; it does not establish an inference grant merely from a successful login.
Returned credentials may include email, organization name, and scope metadata.

Optional environment variables:

- `CLAUDE_SUBSCRIPTION_ORG_UUID`: organization hint for the next sign-in.
- `CLAUDE_SUBSCRIPTION_LOGIN_HINT`: email hint for that URL.

There is no API-key or access-token environment fallback: sign-in is the only
credential path, so Pi can renew the session and the provider stays hidden until you
have signed in.

Pi's bundled Anthropic catalog and Anthropic Messages streamer are reused.
List-price estimates are not actual subscription charges. The catalog's
per-token rates match Anthropic's published table as of 2026-10-17; see
[pricing](../pricing.md) for how to re-verify them and what a per-token
catalog cannot represent.

## Subscription inference gate

Subscription OAuth inference through `api.anthropic.com` is gated by a fuzzy
prompt-content classifier over the request's system param and system-role
messages. Empirically derived by live bisection against the backend
(2026-10-16), each outgoing request is rewritten before transport:

1. The system param is reduced to the single canonical first-party identity
   line (required verbatim; generic first blocks get 429).
2. All other system blocks are moved, unchanged, into the first user message
   (preserving `cache_control` and unknown fields), after any leading
   `tool_result` blocks that must remain first under the Anthropic API.
3. Every system-role message anywhere in the conversation is absorbed into an
   adjacent user message; a user message is inserted if none exists. Third-party
   harness prompts in the system param or as system-role messages trip the
classifier (400 "out of extra usage" / 429); the same content passes when
carried in user messages, Claude Code's own `<system-reminder>` pattern.

The transform is idempotent, non-mutating, and fail-safe: it never sends an
un-gated payload. It is chained after the caller's `onPayload` hook so Pi's
own request inspection still runs first.

This **works around a server-side check on third-party harness prompts**. It
does not raise account limits, forge Claude Code attribution, or change account
permissions, and requests without valid subscription attribution may still be
billed as account "extra usage". It can conflict with the provider's terms for
subscription use; that risk is yours to assess, and the rules can change or be
enforced differently at any time.

## Protocol-drift diagnostics

The gate rules are an undocumented backend contract and can change without
notice. When a request is rejected (HTTP 400, 401, 403, or 429), Pi would
normally show only the SDK's one-line error. This domain replaces it with one
credential-safe report (`src/domains/claude/diagnostics.ts`):

- HTTP status plus a per-status interpretation (classifier rejection vs. expired
  token vs. org restriction vs. real rate limit).
- `request-id` and every `anthropic-ratelimit-*` header; absence of quota
  headers is reported as a signal in itself.
- The provider error `type` (allowlisted pattern) and a truncated, redacted
  message, so "out of extra usage" can be told apart from a genuine invalid request.
- A structural fingerprint of the gated request: model, message/tool counts,
  `max_tokens`, system block count, whether the canonical line matched, and how
  many system-role messages survived. Counts and booleans only.
- The canonical identity line to compare against, and a checklist of what has
  historically changed.
- The SDK's original error text, redacted and truncated, as a trailing line.

The same facts are attached as a structured `claude_subscription_protocol_drift`
entry in the message's `diagnostics`. Only failed requests (not aborted ones)
are enriched; other failures such as HTTP 500 keep the SDK's own error.

Safety posture: login and transport helpers never echo provider bodies. This
runtime report is a deliberate, documented exception limited to the redacted
error summary above. The report never contains tokens (no `sk-ant` substring
is ever emitted), prompt content, tool names, or full response bodies.

Implementation note, verified against the installed Anthropic SDK: the SDK
throws for every non-2xx response before pi-ai's `onResponse` hook runs, so
that hook never sees a rejection. The response is therefore captured in a
`fetch` wrapper (reset on every call, so a stale rejection is never reused) and
the report is attached as the stream's terminal `error` event passes through.
The caller's own `fetch`, `onResponse`, and `onPayload` are preserved.

Client-identity headers (`user-agent: claude-cli/<version>`, `x-app: cli`,
the `oauth-2025-04-20`/`claude-code-20250219` betas, bearer auth) are applied
automatically by Pi's bundled Anthropic implementation when the resolved key
contains `sk-ant-oat`. This domain adds no header overrides of its own.

Live E2E subscription turns through this package remain unverified here; the
gate rules were verified against the backend on 2026-10-16 and can change
without notice.

Expiry uses the validated server lifetime minus the smaller of five minutes or
10% of that lifetime. The adapter returns replacement refresh credentials;
Pi owns persistence and coordination. End-to-end refresh at actual expiry,
concurrent refresh recovery, and live inference remain unverified here.
