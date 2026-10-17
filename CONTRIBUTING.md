# Contributing

Thank you for contributing to `pi-integrations`. This repository follows strict red-first TDD, dependency-injected domain boundaries, and zero-credential-leakage rules.

## Development Setup

Use **Bun 1.4.3** and the committed `bun.lock`:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check          # TypeScript type-check (tsc --noEmit)
bun test               # Full unit & contract test suite
bun run test:coverage  # Coverage report across all domains and shared primitives
bun run ci             # Full local CI pipeline (mirrors .github/workflows/ci.yml)
```

### Domain-Scoped Suites

Each domain can be tested in isolation:

| Suite | Command |
| --- | --- |
| Shared primitives (`src/shared`) | `bun run test:shared` |
| Claude Subscription (`src/domains/claude`) | `bun run test:claude` |
| Codex Subscription (`src/domains/codex`) | `bun run test:codex` |
| Antigravity (`src/domains/agy`) | `bun run test:agy` |
| Spettro (`src/domains/spettro`) | `bun run test:spettro` |
| Mistral Vibe (`src/domains/mistral-vibe`) | `bun run test:mistral-vibe` |
| Decision Router & Apple Foundation Models | `bun run test:decision-router` |
| Package & Harness Contracts | `bun run test:contracts` |

Run `bun run verify:pricing` (requires network access) after touching a model catalog or pricing parser.

---

## Testing & Evidence Discipline

1. **Red-First TDD:** Write a failing test that reproduces the bug or defines the new contract before writing implementation code. When guarding a hang, boundary, or regression, revert the fix once to verify the test actually fails.
2. **Hermetic Tests Only:** Automated tests must never make live network requests or read the developer's real `~/.pi` or `~/.config/pi-integrations` credential files. Inject `fetchImpl`, file readers, clocks (`virtualClock`), and sleeps (`sequenceFetch`, `loginCallbacks` in `test/support/fixtures.ts`).
3. **Stalled-Body Cancellation:** A fixture stream that closes on its own cannot expose an unbounded read. Use deliberately open streams (see `test/shared/http-abort.test.ts`) when testing timeouts and cancellation.
4. **Never Commit Captures or Credentials:** Never commit raw proxy captures, account exports, OAuth tokens, client secrets, browser authorization strings, or session transcripts. `test/agy/no-bundled-secret.test.ts` scans all tracked files across plaintext, `base64`, `base64url`, `hex`, reversed strings, and concatenated literals.
5. **Distinguish Evidence Levels:** In code comments and `docs/`, state clearly whether a protocol claim comes from:
   - **Live measurement / bisection** (e.g. the Antigravity `antigravity/cli/` User-Agent gate, Claude prompt classifier rules, Apple Foundation Models Swift bridge execution),
   - **Binary / descriptor extraction** (e.g. protobuf descriptors or CLI string tables), or
   - **Unverified inference** (must degrade safely on failure).

---

## Code Boundaries

- **Domain Isolation:** Keep provider-specific endpoints, headers, and schemas inside `src/domains/<domain>/`. `src/shared/` must remain free of provider URLs or singleton state.
- **Reuse Shared Primitives:** Use `requestText`, `requestJson`, `generatePKCE`, `pollUntil`, `startLoopback`, `iterateSse`, `safeBaseUrl`, and `trustedUrl` from `src/shared/` wherever the protocol semantics match.
- **Small Entry Points:** Keep each domain's `index.ts` minimal (wiring `pi.registerProvider` or `pi.registerVirtualModel`), and put testable factory functions in `provider.ts` or `router.ts`.
- **Harness Contracts:** `test/package/contracts.test.ts` verifies what Pi actually receives from each `index.ts` entry point—complete provider configs, live event-stream delegation, and placeholder guards. Update it when adding a domain.

See [docs/architecture.md](docs/architecture.md) for a step-by-step guide to adding a new domain, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
