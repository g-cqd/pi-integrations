# Architecture & Reusable Components

`pi-integrations` is organized as **eight independent domain extensions** built on a single zero-endpoint shared library (`src/shared/`). Each domain registers its own provider or virtual models and can be loaded or filtered independently in Pi.

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                         decision-router (Virtual)                         │
│   System One Classifier (vllm-d3-lite / Laya / Jev / Heuristic Fallback)  │
│   + Live Quota Tracker (Claude / Codex / Agy) + Accuracy/Latency Scorer   │
└───────┬───────────────┬───────────────┬───────────────┬──────────────┬────┘
        │               │               │               │              │
        ▼               ▼               ▼               ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────────┐
│    claude    │ │    codex     │ │     agy      │ │ spettro  │ │ apple-foundation │
│ subscription │ │ subscription │ │ subscription │ │  & vibe  │ │ (On-Device 3B)   │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └────┬─────┘ └────────┬─────────┘
       │                │                │              │                │
       └────────────────┴────────────────┼──────────────┘                │
                                         ▼                               ▼
                    ┌─────────────────────────────────────────┐   ┌──────────────┐
                    │               src/shared/               │   │ Native Swift │
                    │  http · urls · pkce · polling · sse     │   │ Foundation   │
                    │  credentials · jwt · loopback           │   │ Models Bridge│
                    └─────────────────────────────────────────┘   └──────────────┘
```

The diagram groups remote domains schematically; the independent `copilot-vscode` provider also uses `src/shared/`, without replacing Pi's built-in `github-copilot`. It has no Copilot-specific live quota probe.

---

## Shared Primitives (`pi-integrations/shared`)

`src/shared/index.ts` exports pure, dependency-injected building blocks with zero provider-specific constants:

| Primitive | File | Responsibility |
| --- | --- | --- |
| `requestText`, `requestJson`, `HttpStatusError`, `RESPONSE_LIMIT_BYTES` | `src/shared/http.ts` | 30-second timeout, caller `AbortSignal` racing on both headers and body chunks, `redirect: "error"`, 1 MiB response cap, and sanitized transport errors. |
| `safeBaseUrl`, `browserUrl`, `trustedUrl` | `src/shared/urls.ts` | Enforces HTTPS (or explicit loopback HTTP for base URLs), rejects userinfo/query/fragment on base URLs, and pins polling/browser URLs to trusted origins. |
| `generatePKCE` | `src/shared/pkce.ts` | Generates fresh 32-byte cryptographic verifiers and S256 `base64url` challenges (RFC 7636). |
| `pollUntil`, `waitFor`, `SLOW_DOWN_INCREMENT_MS` | `src/shared/polling.ts` | Deadline-clamped polling orchestrator with RFC 8628 `slow_down` (+5s) backoff, `delayFirst`, and injectable virtual clock/sleep for instant tests. |
| `validSecret`, `apiKeyCredentials`, `expiryAfter`, `record` | `src/shared/credentials.ts` | Rejects whitespace/control characters in secrets, computes token expiry with a `min(5m, 10%)` safety margin, and wraps API keys for Pi's OAuth store. |
| `jwtPayload` | `src/shared/jwt.ts` | Decodes `base64url` JWT claims (such as `chatgpt_account_id` or email) for routing without trusting unverified signatures for authorization. |
| `startLoopback`, `awaitAuthorizationInput` | `src/shared/loopback.ts` | One-shot `127.0.0.1` OAuth callback server (DNS-rebinding guard, exact path, state check) and race helper against manual pasted input. |
| `iterateSse`, `SSE_MAX_EVENT_BYTES` | `src/shared/sse.ts` | Streaming Server-Sent Events parser handling CRLF/LF/CR, UTF-8 BOM, split multi-byte characters, 4 MiB per-event cap, and abort-raced reads. |

---

## Domain Responsibilities

| Domain | Directory | What It Owns | How Inference Runs |
| --- | --- | --- | --- |
| **Claude** | `src/domains/claude/` | PKCE OAuth (`claude.com` → `platform.claude.com`), system-prompt subscription gate (`gate.ts`), and 4xx protocol-drift diagnostics (`diagnostics.ts`). | Delegates to Pi's `anthropicMessagesApi`, wrapped by `subscriptionGateStreamSimple`. |
| **Copilot** | `src/domains/copilot/` | Source-derived VS Code GitHub device auth, Copilot session-token exchange, trusted API endpoint selection, and account catalog. Not live-validated or exact VS Code parity. | Custom `copilot-vscode-chat` dispatch selects generic Pi Responses, Messages or Completions adapters with pinned Bearer auth. See [limits](domains/copilot.md). |
| **Codex** | `src/domains/codex/` | ChatGPT PKCE OAuth (loopback `:1455`, paste fallback, and device-code flow) + live `/backend-api/codex/models` catalog with static fallback. | Delegates to Pi's `openAICodexResponsesApi`. |
| **Antigravity** | `src/domains/agy/` | Google Desktop PKCE OAuth, automatic in-memory `agy` binary secret resolver, `loadCodeAssist`, `fetchAvailableModels`, and `antigravity/cli/` UA gate. | Custom `cloudcode-pa` SSE streamer (`stream.ts`) built with Pi's exported Google message/tool converters. |
| **Spettro** | `src/domains/spettro/` | Browser device-session initiation, polling, and live `/v1/models` catalog discovery + persistence. | Delegates to Pi's `openAICompletionsApi` (`supportsDeveloperRole: false`). |
| **Mistral Vibe** | `src/domains/mistral-vibe/` | Console PKCE sign-in process creation, polling, and API-key exchange, scoped to `mistral-large-4`. | Delegates to Pi's `mistralConversationsApi`. |
| **Apple Foundation** | `src/domains/apple-foundation/` | macOS 26+ `FoundationModels` availability check, auto-enablement on Apple Silicon, full tool JSON Schema extraction, and cached Swift bridge (`apple-fm-bridge-v2`). | Custom local streamer invoking `LanguageModelSession` (`streamResponse` or `@Generable` tool calls). |
| **Decision Router** | `src/domains/decision-router/` | System One classifier client (`vllm-d3-lite` / `Laya` / `Jev`), live subscription quota probes (`quota.ts`), accuracy/latency/cost utility scorer (`classifier.ts`), and virtual model definitions (`router.ts`). | Resolves to a physical `Model<Api>` per turn; Pi dispatches directly to the chosen physical provider. |

---

## Adding a New Domain

1. Create `src/domains/<name>/provider.ts` exporting a dependency-injected factory (`create<Name>Provider(deps)`) and `src/domains/<name>/index.ts` for Pi registration.
2. Reuse `src/shared/` primitives where protocol semantics match. Never hardcode live credentials or read user token stores in tests.
3. If the domain refreshes a live model catalog, restore from `context.stored` when `!context.allowNetwork` and call `await context.publish({ persist: { models, checkedAt } })` on network success so the catalog persists in `models-store.json`.
4. Write red-first unit tests under `test/<name>/` and add the entry point to `package.json`, `test/package/contracts.test.ts`, and `scripts/smoke-registration.sh`.
5. Run `bun run ci` to verify type-checking, test coverage, and offline CLI registration.
