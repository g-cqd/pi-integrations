# pi-integrations

[![CI](https://img.shields.io/badge/CI-bun%20run%20ci-2ea44f?style=flat-square)](scripts/ci.sh)
[![Bun](https://img.shields.io/badge/Bun-1.4.3-f9f1e1?style=flat-square&logo=bun)](https://bun.sh)
[![Pi](https://img.shields.io/badge/Pi-1.3.0-5865F2?style=flat-square)](https://github.com/earendil-works/pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

Modular subscription, local-model, and decision-routing integrations for [Pi](https://github.com/earendil-works/pi), built on a zero-dependency shared authentication and transport layer.

---

## Highlights

- **Eight Independently Loadable Domains** — Claude, OpenAI Codex, Google Antigravity (`agy`), Spettro, Mistral Vibe, experimental VS Code-style Copilot, On-Device Apple Foundation Models (`FoundationModels`), and a synthetic System One **Decision Router**.
- **System One Decision Routing (`decision-router`)** — Pairs zero-token single-pass semantic classification (`vllm-d3-lite`, `Laya`, `Jev`) with a multi-objective utility scorer that weighs **estimated accuracy**, **estimated latency**, **live subscription quota headroom**, **per-token pricing**, **zero-cost model promotion**, and **prompt-cache stickiness**.
- **On-Device Apple Foundation Models (`apple-foundation`)** — Zero-cost, private local 3B inference on macOS 26+ Apple Silicon via a cached native Swift bridge (`apple-fm-bridge-v2`), auto-enabled out of the box and exposing every active Pi tool and its full JSON Schema options via `@Generable` guided generation.
- **Zero Bundled Secrets** — Every remote domain signs in through `/login`. Antigravity's desktop OAuth client secret is automatically discovered in memory from your installed `agy` binary and verified against Google's token endpoint without ever being committed or written to disk.
- **Hermetic, Red-First Test Suite** — 500+ tests across 28 suites covering OAuth state machines, stalled-body abort races, multi-encoding secret scanning, live Swift bridge compilation, and Pi harness contracts.

---

## Domain Catalog

| Domain | Pi Provider ID | Sign-In / Activation | Models & Capabilities | Documentation |
| --- | --- | --- | --- | --- |
| **Decision Router** | `decision-router` | Always available (`decision-router/router`, `auto`, `lowest`, `medium`, `highest`) | Maps `/thinking` (`low` / `medium` / `high` / `xhigh`=Auto) to the highest-utility model across your active subscriptions & local models | [docs/domains/decision-router.md](docs/domains/decision-router.md) |
| **Apple Foundation Models** | `apple-foundation` | Auto-enabled on macOS 26+ Apple Silicon, or explicit `/login` verification | On-device 3B (`apple-foundation-local`, `apple-foundation-content-tagging`) with `@Generable` structured tool calls | [docs/domains/decision-router.md#apple-foundation-models-apple-foundation](docs/domains/decision-router.md#apple-foundation-models-apple-foundation) |
| **Claude Subscription** | `claude-subscription` | Browser OAuth + pasted `code#state` (PKCE S256) | Pi's Anthropic catalog (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1) + subscription inference gate & drift diagnostics | [docs/domains/claude.md](docs/domains/claude.md) |
| **Codex Subscription** | `codex-subscription` | ChatGPT browser callback (`:1455` / paste) or headless device code | Live account catalog (`/backend-api/codex/models`) with automatic fallback to Pi's static Codex catalog | [docs/domains/codex.md](docs/domains/codex.md) |
| **Antigravity (`agy`)** | `agy-subscription` | Google OAuth pasted code + automatic local binary client-secret discovery | Live Cloud Code catalog (`gemini-4-argon-*`, `gemini-3.8-flash-*`, `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, `gpt-oss-120b-medium`) | [docs/domains/agy.md](docs/domains/agy.md) |
| **Spettro** | `spettro` | Browser device session + polling | Live `/v1/models` catalog discovered from your signed-in account | [docs/domains/spettro.md](docs/domains/spettro.md) |
| **Copilot (VS Code-style)** | `copilot-vscode` | GitHub device approval using the source-published VS Code OAuth client | Account catalog + Responses / Messages / Chat Completions; official Copilot pricing with cached refresh; quota footer bar (live quota/billing parity unverified) | [docs/domains/copilot.md](docs/domains/copilot.md) |
| **Mistral Vibe** | `mistral-vibe` | Browser approval + PKCE polling/exchange | Service-issued API key scoped to **Mistral Large 4** (`mistral-large-4`, 1M context) | [docs/domains/mistral-vibe.md](docs/domains/mistral-vibe.md) |

> [!IMPORTANT]
> **Experimental & Unofficial.** A successful login is not proof of inference entitlement, subscription billing, model availability, or zero charges. Model catalogs narrow what is *offered*, not what is permitted; a `403` or `429` from an inference request is still the authoritative signal. Review each provider's terms before signing in. This project is not affiliated with the providers or Pi maintainers.

---

## Quick Start

### 1. Install into Pi

Ensure Pi is configured to use **Bun** in `~/.pi/agent/settings.json`:

```json
{
  "npmCommand": ["bun"]
}
```

Then install the package directly from Git:

```sh
pi install git:github.com/g-cqd/pi-integrations
pi
```

Pi auto-loads all eight domain entry points listed in `package.json`.

<details>
<summary><strong>Local checkout or selective domain loading</strong></summary>

For local development:

```sh
git clone https://github.com/g-cqd/pi-integrations.git
cd pi-integrations
bun install --frozen-lockfile --ignore-scripts
pi install .
```

To load only specific domains, filter `extensions` in `~/.pi/agent/settings.json` (or via `pi config`):

```json
{
  "packages": [{
    "source": "git:github.com/g-cqd/pi-integrations",
    "extensions": [
      "src/domains/claude/index.ts",
      "src/domains/codex/index.ts",
      "src/domains/agy/index.ts",
      "src/domains/spettro/index.ts",
      "src/domains/apple-foundation/index.ts",
      "src/domains/decision-router/index.ts"
    ]
  }]
}
```
</details>

### 2. Sign In (`/login`)

Run **`/login`** inside Pi to authenticate the subscriptions you use:

- **Claude Subscription (experimental)** — opens the authorization URL; paste back the `code#state` string.
- **Codex Subscription (experimental)** — choose **Browser sign-in** (auto-completes via loopback `:1455` or pasted redirect URL if port 1455 is busy) or **Device code sign-in** for headless machines.
- **Antigravity Subscription (experimental)** — automatically discovers and verifies the OAuth client secret from your installed `agy` binary (or `AGY_OAUTH_CLIENT_SECRET`), opens the Google sign-in link, and resolves your Cloud Code project (`aicode-consumers`).
- **Spettro Subscription** — opens the browser approval link and polls until your device key is issued.
- **Copilot — VS Code-style (experimental)** — GitHub device approval, Copilot session-token exchange, then account model discovery. Independent of Pi's built-in `github-copilot`; [limitations and validation plan](docs/domains/copilot.md).
- **Mistral Vibe (experimental)** — opens the Mistral Console approval link and exchanges the PKCE grant for a key.
- **Apple Foundation Models (On-Device)** — already auto-enabled on macOS 26+ Apple Silicon; running `/login` explicitly verifies `SystemLanguageModel.default.availability` and saves the marker credential.

### 3. Select a Model or Use the Decision Router (`/model`)

Run **`/model`** to pick any provider's physical model directly, or select **`decision-router/router`** and use **`/thinking`** to control how requests are routed:

| `/thinking` Level | Shortcut Virtual Model | Routing Behavior |
| --- | --- | --- |
| `low` | `decision-router/lowest` | Routes to the best **Lowest** tier model (`apple-foundation-local` on-device 3B for quick local tasks, `claude-haiku-5-5`, `gpt-6-luna`, `gemini-3.5-flash-lite`, `gemini-3.8-flash-low`) |
| `medium` | `decision-router/medium` | Routes to the best **Medium** tier model (`claude-sonnet-5-5`, `gemini-4-argon-medium`, `gpt-5.6-terra`, `gemini-3.8-flash-medium`, `mistral-large-4`) |
| `high` | `decision-router/highest` | Routes to the best **Highest** tier model (`gpt-6.1-sol`, `claude-opus-5-5`, `gemini-4-argon-high`, `claude-fable-5-1`, `gpt-6-astra`) |
| `xhigh` | `decision-router/auto` | **Auto Mode:** queries the System One decision model (`vllm-d3-lite` / `Laya` / `Jev`) for `tier`, `task_profile`, and `local_ok`, then scores all surviving candidates against live subscription quotas, latency, accuracy, and price |

---

## Optional Local Decision Server (`vllm-d3-lite`)

The Decision Router works out of the box with zero external servers (falling back to any registered Pi classifier or its built-in deterministic heuristic). For maximum local routing accuracy on Apple Silicon, run **`vllm-d3-lite-Q8_0.gguf`** (0.85B parameters, 1.03 GB, #1 Pareto frontier on the Jev Decision Index ≤1B) via `llama-server`:

```sh
mkdir -p ~/.models/decision
curl -fsSL -o ~/.models/decision/vllm-d3-lite-Q8_0.gguf \
  https://huggingface.co/ggml-org/vllm-d3-lite-GGUF/resolve/main/vllm-d3-lite-Q8_0.gguf

# Note: -ub 2048 -b 2048 is required for non-causal bidirectional decision attention in llama.cpp 0.7+
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

See [docs/domains/decision-router.md](docs/domains/decision-router.md) for M2 Pro benchmarks (`vllm-d3-lite` vs. `Laya` vs. `vllm-d3-edge` vs. `LiquidAI d1-omni-600M` vs. `Julia-1`), per-model accuracy/latency tables, and custom JSON configuration (`~/.config/pi-integrations/decision-router.json`).

---

## Repository Architecture

```text
src/
  shared/                   Zero-endpoint reusable authentication & transport primitives
    http.ts                 Signal-raced 1 MiB bounded reads, 30s timeout, redirect refusal
    urls.ts                 HTTPS/loopback base-URL and origin/path boundary validation
    pkce.ts                 RFC 7636 S256 verifier and challenge generation
    polling.ts              Deadline-clamped polling, RFC 8628 slow_down, injectable clock
    credentials.ts          Secret validation, expiry safety margins, API-key bookkeeping
    jwt.ts                  Unverified JWT payload decoding for routing claims (accountId)
    loopback.ts             One-shot 127.0.0.1 OAuth callback server + manual paste race
    sse.ts                  Per-event bounded Server-Sent Events reader with abort racing
  domains/
    claude/                 OAuth PKCE + subscription inference gate + drift diagnostics
    codex/                  ChatGPT OAuth (loopback + device code) + live /codex/models catalog
    copilot/                Source-derived VS Code-style auth + Copilot session/catalog transport
    agy/                    Google OAuth + in-memory binary secret discovery + cloudcode-pa stream
    spettro/                Device-session polling + live /v1/models catalog
    mistral-vibe/           Console PKCE polling + API-key exchange (Mistral Large 4)
    apple-foundation/       macOS 26+ FoundationModels native Swift bridge + @Generable tools
    decision-router/        System One classifier client + live quota probes + utility router
scripts/
  ci.sh                     Local CI pipeline mirroring .github/workflows/ci.yml
  smoke-registration.sh     Offline end-to-end Pi CLI registration smoke test
  verify-pricing.ts         Live verifier diffing vendor price pages against Pi catalogs
  extract-agy-client-secret.ts  Optional standalone operator tool for agy secret verification
```

### Documentation Index

- **Architecture & Shared Primitives:** [docs/architecture.md](docs/architecture.md)
- **Domain Guides:**
  - [Decision Router & Apple Foundation Models](docs/domains/decision-router.md)
  - [Claude Subscription](docs/domains/claude.md)
  - [Codex Subscription](docs/domains/codex.md)
  - [Copilot — VS Code-style (experimental)](docs/domains/copilot.md)
  - [Antigravity (`agy`) Subscription](docs/domains/agy.md)
  - [Spettro Subscription](docs/domains/spettro.md)
  - [Mistral Vibe](docs/domains/mistral-vibe.md)
- **Protocol Verification & Pricing:**
  - [Per-Token Pricing Verification (`bun run verify:pricing`)](docs/pricing.md)
  - [Harness Proxy Methodology](docs/harness-proxy.md)
  - [Codex & Antigravity Login Investigation Notes](docs/investigations/codex-and-agy-login.md)
- **Governance:** [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md)

---

## Development & Verification

Verified with **Bun 1.4.3** and **Pi 1.3.0**:

```sh
bun run ci                    # frozen install + tsc --noEmit + coverage suite + offline CLI smoke test
bun test                      # run all 513 unit & contract tests
bun run verify:pricing        # compare Pi catalog prices against live Anthropic/OpenAI/Mistral tables
```

Run individual domain suites:

```sh
bun run test:claude
bun run test:codex
bun run test:agy
bun run test:spettro
bun run test:mistral-vibe
bun run test:decision-router
bun run test:shared
bun run test:contracts
```

---

## Security & Credential Lifecycle

- **Plaintext Storage:** Pi persists credentials in `~/.pi/agent/auth.json`. Keep that file private and never commit it.
- **No Secret Bundling:** `test/agy/no-bundled-secret.test.ts` decodes candidate spans (`base64`, `base64url`, `hex`, reversed text, and joined string literals) across the entire repository to prevent accidental credential commits in any encoding.
- **Logout vs. Revocation:** Running `/logout` in Pi deletes the local credential entry; revoke active sessions or keys in your provider's account settings when needed.

See [SECURITY.md](SECURITY.md) for full boundary documentation and private vulnerability reporting.

## License

[MIT](LICENSE). Independent project; product and model names belong to their respective owners.
