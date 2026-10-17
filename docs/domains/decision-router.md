# Decision Router (`decision-router`) and Apple Foundation Models (`apple-foundation`)

Provider IDs:
- `decision-router` — synthetic virtual-model router (`decision-router/router`, `decision-router/auto`, `decision-router/lowest`, `decision-router/medium`, `decision-router/highest`)
- `apple-foundation` — local on-device Apple Foundation Models (`apple-foundation-local`, `apple-foundation-content-tagging`)

## Overview & Vision

The Decision Router is a two-stage synthetic routing layer that maps a single virtual model selection (`decision-router/router`) and thinking level (`low` = **Lowest**, `medium` = **Medium**, `high` = **Highest**, `xhigh` = **Auto**) onto the optimal physical model across all signed-in subscriptions and local models:

1. **Stage 1 — Single-Pass Semantic Classification (`vllm-d3-lite` / `Laya` / `Jev`):**
   When in **Auto** mode (`xhigh` on `decision-router/router` or any level on `decision-router/auto`), a System One decision model evaluates the prompt in one forward pass (zero generated tokens) and outputs:
   - `tier`: `lowest` | `medium` | `highest`
   - `task_profile`: `quick_edit` | `code_implementation` | `deep_architecture`
   - `local_ok` (`noul`): calibrated probability that a compact 3B on-device model can handle the request without multi-step frontier reasoning.
   If no local or cloud System One server is running, a deterministic heuristic classifier takes over with zero network latency.

2. **Stage 2 — Multi-Objective Utility Scorer (Accuracy + Latency + Live Quota + Price + Cache Stickiness):**
   Given the target tier and task profile, the router scores every configured candidate model using:
   - `estimatedAccuracy` (in `[0, 1]`, grounded in 2026-10-17 coding/reasoning benchmarks) + task-profile specialization bonus
   - `estimatedLatencyMs` (median time-to-first-useful-turn penalty)
   - Live subscription quota headroom (`fiveHourRemaining` and `weeklyRemaining` from Claude, Codex, and Antigravity quota endpoints, with nonlinear conservation below 20% remaining)
   - List-price token cost + **zero-cost model promotion** (such as on-device Apple Foundation Models and zero-cost subscription models)
   - Prompt-cache stickiness bonus when staying on the previous turn's model
   - Automatic cross-tier escalation/degradation and retry failover when a provider hits a usage limit mid-session.

---

## Decision Model Benchmarks on Apple Silicon (M2 Pro, 16 GB)

Measured locally via `llama-server` (`0.7.0`, `/v1/systemone`) across a 6-prompt software engineering routing suite (3 questions answered jointly per pass):

| Decision Model | GGUF Quant | Size | Official Index | Measured Latency (3 Qs) | Routing Accuracy | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| **`ggml-org/vllm-d3-lite-GGUF`** | `vllm-d3-lite-Q8_0.gguf` | **1.03 GB** | **32.3** (#1 Pareto ≤1B) | **335.7 ms** | **6 / 6 (100%)** | **Recommended primary local model.** Well-calibrated `local_ok` and `task_profile` probabilities. Requires `-ub 2048 -b 2048`. |
| **`ggml-org/Laya-GGUF`** | `Laya-Q8_0.gguf` | **429 MB** | 0.766 (`typed-decisions`) | **121.8 ms** | **6 / 6 (100%)** | Ultra-lightweight ModernBERT bidirectional decision head. Fastest local alternative. |
| `ggml-org/vllm-d3-edge-GGUF` | `vllm-d3-edge-Q8_0.gguf` | 769 MB | 20.2 | 122.1 ms | 6 / 6 (100%) | Lower confidence margin on medium/high boundary. |
| `LiquidAI/d1-omni-600M-GGUF` | `d1-omni-600M-Q8_0.gguf` | 388 MB | 9.1 | 153.3 ms | — | Weaker zero-shot software-engineering separation. |
| `ggml-org/Julia-1-GGUF` | `Julia-1-Q8_0.gguf` | 160 MB | — | 37.3 ms | — | Over-collapses toward a single label zero-shot. |

---

## Local Setup: `vllm-d3-lite` with `llama-server`

1. **Download `vllm-d3-lite-Q8_0.gguf` (already placed in `~/.models/decision/` on this machine):**

```sh
mkdir -p ~/.models/decision
curl -fsSL -o ~/.models/decision/vllm-d3-lite-Q8_0.gguf \
  https://huggingface.co/ggml-org/vllm-d3-lite-GGUF/resolve/main/vllm-d3-lite-Q8_0.gguf
```

2. **Start `llama-server` on port `18080`:**

> **Important:** `vllm-d3` uses non-causal bidirectional attention over the state and options. In `llama.cpp 0.7.0`, pass `-ub 2048 -b 2048` so `n_ubatch >= n_tokens` holds on long prompts.

```sh
llama-server \
  -m ~/.models/decision/vllm-d3-lite-Q8_0.gguf \
  --host 127.0.0.1 \
  --port 18080 \
  -ngl 999 \
  -c 8192 \
  -ub 2048 \
  -b 2048 \
  --cache-ram 256
```

Override the endpoint URL at any time with `PI_DECISION_ROUTER_URL=http://127.0.0.1:18080/v1/systemone`. If `llama-server` is not running, the router automatically tries Pi's registered classifiers (`llama.cpp`, TypeSafe `jev-latest`, OpenRouter `inception/mercury-decide:free`) and then falls back to its built-in deterministic heuristic classifier.

---

## Subscription & Model Tier Estimates (2026-10-17)

Every subscription and candidate model carries explicit `estimatedAccuracy` and `estimatedLatencyMs` values in `src/domains/decision-router/config.ts`:

### Subscription Baselines

| Provider ID | Subscription | Est. Accuracy | Est. Latency | Live Quota Endpoint |
| --- | --- | ---: | ---: | --- |
| `apple-foundation` | Apple Foundation Models (On-Device 3B) | `0.68` | `420 ms` | Always 100% (local ANE/GPU) |
| `spettro` | Spettro Subscription | `0.91` | `680 ms` | Account-scoped |
| `claude-subscription` | Claude Subscription (Haiku / Sonnet / Opus 5.5 / Fable 5.1) | `0.95` | `1150 ms` | `GET https://api.anthropic.com/api/oauth/usage` (`five_hour` + `seven_day`) |
| `codex-subscription` | Codex Subscription (Luna / Terra / Sol / Astra) | `0.95` | `1250 ms` | `GET https://chatgpt.com/backend-api/codex/usage` (`primary_window` + `secondary_window` + `model_usage`) |
| `agy-subscription` | Antigravity Subscription (Gemini 3.8 Flash / 4 Argon / Claude 5.5) | `0.93` | `950 ms` | `POST .../v1internal:retrieveUserQuotaSummary` (`5h` + `weekly` buckets) |
| `mistral-vibe` | Mistral Vibe (`mistral-large-4`) | `0.87` | `980 ms` | Key-based |

### Tier Candidate Sets

| Tier | Provider / Model ID | Physical Thinking | Est. Accuracy | Est. Latency | Input / Output ($/M) | Special Role |
| --- | --- | --- | ---: | ---: | ---: | --- |
| **Lowest** (`low`) | `apple-foundation/apple-foundation-local` | `off` | `0.68` | `420 ms` | `$0 / $0` | **On-device 3B**; promoted when `local_ok >= 0.65` and prompt `< 1500` tokens |
| **Lowest** (`low`) | `claude-subscription/claude-haiku-5-5` | `low` | `0.85` | `620 ms` | `$0.10 / $0.50` | Fast 1M-context Haiku 5.5 |
| **Lowest** (`low`) | `codex-subscription/gpt-6-luna` | `low` | `0.86` | `640 ms` | `$0.10 / $0.50` | Fast Codex workhorse |
| **Lowest** (`low`) | `agy-subscription/gemini-3.5-flash-lite` | `low` | `0.79` | `520 ms` | `$0.075 / $0.30` | Ultra-lightweight Gemini |
| **Lowest** (`low`) | `agy-subscription/gemini-3.8-flash-low` | `low` | `0.84` | `690 ms` | `$0.75 / $3.75` | 1M-context Flash Low |
| **Medium** (`medium`) | `claude-subscription/claude-sonnet-5-5` | `medium` | `0.92` | `1150 ms` | `$2.00 / $10.00` | Primary Claude engineering model |
| **Medium** (`medium`) | `agy-subscription/gemini-4-argon-medium` | `medium` | `0.92` | `1080 ms` | `$2.00 / $10.00` | Default Antigravity reasoning model |
| **Medium** (`medium`) | `codex-subscription/gpt-5.6-terra` | `medium` | `0.90` | `1100 ms` | `$2.00 / $12.00` | Balanced Codex coding model |
| **Medium** (`medium`) | `agy-subscription/gemini-3.8-flash-medium` | `medium` | `0.88` | `820 ms` | `$0.75 / $3.75` | Fast 1M-context medium model |
| **Medium** (`medium`) | `mistral-vibe/mistral-large-4` | `medium` | `0.87` | `980 ms` | `$0.68 / $2.09` | 1M-context Mistral Large 4 (sale rate) |
| **Highest** (`high`) | `codex-subscription/gpt-6.1-sol` | `high` | `0.96` | `1650 ms` | `$2.00 / $10.00` | 500k-context flagship Codex model |
| **Highest** (`high`) | `claude-subscription/claude-opus-5-5` | `high` | `0.97` | `1850 ms` | `$4.00 / $20.00` | Deep architectural & concurrency reasoning |
| **Highest** (`high`) | `agy-subscription/gemini-4-argon-high` | `high` | `0.95` | `1550 ms` | `$2.00 / $10.00` | High-effort Gemini 4 Argon |
| **Highest** (`high`) | `agy-subscription/claude-opus-5-5-high` | `high` | `0.97` | `1900 ms` | `$4.00 / $20.00` | Opus 5.5 High via Antigravity quota |
| **Highest** (`high`) | `claude-subscription/claude-fable-5-1` | `high` | `0.98` | `2400 ms` | `$10.00 / $50.00` | Frontier Claude Fable 5.1 |
| **Highest** (`high`) | `codex-subscription/gpt-6-astra` | `high` | `0.98` | `2300 ms` | `$10.00 / $50.00` | Frontier Codex GPT-6 Astra |

### Customizing `~/.config/pi-integrations/decision-router.json`

Override weights or candidate tiers without editing source code by creating `~/.config/pi-integrations/decision-router.json` (or setting `$PI_DECISION_ROUTER_CONFIG`). Any omitted field inherits from `DEFAULT_ROUTER_CONFIG`.

---

## Apple Foundation Models (`apple-foundation`)

- **Auto-selectability & `/login`:** On macOS 26+ on Apple Silicon, `apple-foundation` automatically sets its local credential so `apple-foundation-local` and `apple-foundation-content-tagging` appear immediately in `/model` and are routable by `decision-router`. Running `/login` → **Apple Foundation Models (On-Device)** explicitly invokes `SystemLanguageModel.default.availability` via the Swift bridge and persists the credential in `~/.pi/agent/auth.json`.
- **Full Tool & Option Exposure:** Every active tool in the conversation (`getCurrentTools`), including its full JSON Schema `parameters` and extracted option descriptors (`name`, `type`, `required`, `enum`, `description`), is passed to the Swift bridge. When tools are present, the bridge uses `@Generable` guided generation (`AssistantTurnDecision`) so the on-device 3B model can invoke any tool with structured JSON arguments, and `canonicalizeToolArguments` normalizes common parameter synonyms (`filePath` → `path`, `startIndex` → `offset`) and fills required nullable fields (`null`).
- **Cached Native Bridge:** The Swift bridge source is compiled once via `swiftc -O -parse-as-library` into `~/.cache/pi-integrations/apple-foundation/apple-fm-bridge-v2`.
