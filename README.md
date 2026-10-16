# pi-integrations

Modular provider integrations for [Pi](https://github.com/earendil-works/pi),
with reusable authentication components and **Bun-based development**.

One package, three independently loadable domains:

| Domain | Pi provider ID | Sign-in | What the service returns |
| --- | --- | --- | --- |
| [Claude](docs/domains/claude.md) | `claude-subscription` | Browser authorization + pasted `code#state`, PKCE | OAuth access and rotating refresh tokens |
| [Spettro](docs/domains/spettro.md) | `spettro` | Browser device session + polling | A device API key; no refresh endpoint implemented |
| [Mistral/Vibe](docs/domains/mistral-vibe.md) | `mistral-vibe` | Browser approval + PKCE polling/exchange | A Mistral API key, **not** an OAuth refresh token |

**Experimental and unofficial.** A successful login is not proof of inference
entitlement, subscription billing, model availability, or zero charges. Review
each provider's terms and permissions. This project is not affiliated with the
providers or Pi maintainers.

## Install once, then start Pi normally

```sh
pi install git:github.com/g-cqd/pi-integrations
pi
```

Pi auto-loads installed packages; `-e` is only needed for a one-session trial.
The package explicitly lists the three domain entry points in `package.json`.
It is distributed through Git, not published to a package registry.

For Pi's package operations to use **Bun**, merge this into
`~/.pi/agent/settings.json`, preserving your existing settings:

```json
{
  "npmCommand": ["bun"]
}
```

The legacy setting is named `npmCommand`, but the selected executable is Bun.

### Local development install

```sh
git clone https://github.com/g-cqd/pi-integrations.git
cd pi-integrations
bun install --frozen-lockfile --ignore-scripts
pi install .
```

Pi references this directory without copying it. Keep the checkout in place.
For a temporary trial, use `pi -e .`.

Do not load both an old standalone copy and this package's copy of a domain.
In particular, move an existing `~/.pi/agent/extensions/spettro/` outside the
auto-load directory before enabling this package's Spettro domain.

### Load only selected domains

Pi package resource filters can select domain entry points. For example, a
package declaration in `~/.pi/agent/settings.json` can enable only Spettro:

```json
{
  "packages": [{
    "source": "git:github.com/g-cqd/pi-integrations",
    "extensions": ["src/domains/spettro/index.ts"]
  }]
}
```

Edit the existing package declaration rather than adding another copy.
`pi config` also exposes package resource selection.

## Sign in

In Pi, run **`/login`** and choose:

- **Claude OAuth (experimental)** — follow the link and paste the full
  `code#state` from that attempt.
- **Spettro Subscription** — finish browser sign-in; Pi polls the device session.
- **Mistral Vibe (experimental)** — finish browser sign-in; Pi polls and performs
  the PKCE-bound API-key exchange. It does not read Vibe's Keychain.

Then run **`/model`** and select a model under the corresponding provider ID.

Claude and Mistral/Vibe use Pi's bundled model catalogs, not account-specific
entitlement lists. Spettro discovers models using authenticated `/v1/models`.
Its initial catalog placeholder is not an inference model and cannot be sent.

## Shared components, domain-specific protocols

```text
src/
  shared/                 reusable primitives; no provider endpoints
    http.ts               bounded HTTP reads, deadlines, safe errors
    urls.ts               HTTPS/origin/path validation
    pkce.ts               fresh S256 verifier/challenge pairs
    polling.ts            deadlines, cancellation, injectable clock/delay
    credentials.ts        validation and API-key storage bookkeeping
    index.ts              public shared-component exports
  domains/
    claude/               authorization-code OAuth + refresh/revoke helpers
    spettro/              device login + live model discovery
    mistral-vibe/         browser PKCE process + API-key exchange
test/
  shared/                 primitive behavior and adversarial inputs
  claude/                 OAuth flow and response validation
  spettro/                login, catalog, and compatibility behavior
  mistral-vibe/           complete browser-sign-in state machine
  package/                isolation, coexistence, delegation contracts
  support/                synthetic responses, callbacks, virtual clock
```

Domain providers accept injected fetch/stream implementations; polling accepts
an injected clock and sleep function. Tests do not need real provider accounts,
Keychain access, real polling sleeps, or live network calls.

See [the architecture guide](docs/architecture.md) for the reusable API and
rules for adding another domain. These are TypeScript source exports intended
for Pi/Bun consumers, not a compiled general-purpose JavaScript SDK.

## What this package does not do

- It does not run Claude Code, Vibe, or Spettro as subprocess agents.
- It does not use the Claude Agent SDK or claim first-party client identity.
- It does not include the private Claude prototype's system-to-user prompt
  relocation or explicit client user-agent override.
- It does not change account permissions, bypass provider access restrictions,
  route around quota rejection, or promise subscription billing.
- It does not implement its own inference stream parser: Pi owns conversion,
  wire headers/compatibility behavior, streaming, tools, and usage reporting.
  Delegation does not mean those behaviors were independently verified here.

## Credentials and lifecycle

Pi owns storage, normally in **plaintext** `~/.pi/agent/auth.json`. This package
adds neither OS Keychain storage nor encryption. Do not commit or share that file.

- **Claude:** access/refresh expiry comes from token responses. Refresh returns
  replacement credentials for Pi to persist.
- **Spettro and Mistral/Vibe:** the service returns API keys without an expiry
  contract handled here. A distant timestamp is used only for Pi's legacy OAuth
  storage interface; it is **not a ten-year validity guarantee**. Refresh callbacks
  retain the existing credential rather than inventing a refresh endpoint.

**`/logout` removes the Pi credential; it does not revoke it server-side.**
The Claude revoke helper is a code-level API, not wired into `/logout`.
Environment-provided credentials and independently stored Vibe keys remain set.

This package has no telemetry endpoint of its own. The providers, Pi, and its
dependencies have their own behavior and policies. See [SECURITY.md](SECURITY.md).

## Development and verification

Checked development setup: **Bun 1.4.3, Pi 1.3.0**.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test
bun run test:coverage
```

Domain commands: `bun run test:claude`, `bun run test:spettro`,
`bun run test:mistral-vibe`, `bun run test:shared`, `bun run test:contracts`.

Offline registration smoke test. Pi's `--list-models` only lists providers with
available credentials, so the smoke test passes synthetic env keys. Offline mode
keeps Spettro refresh credential-gated, so this makes no network request:

```sh
CLAUDE_SUBSCRIPTION_ACCESS_TOKEN=ci-synthetic \
SPETTRO_API_KEY=ci-synthetic \
MISTRAL_VIBE_API_KEY=ci-synthetic \
pi --offline --no-mcp --no-extensions -e . --list-models
```

Tests cover authentication, validation, failure states, transport boundaries,
cancellation/deadlines, catalog parsing, and request/stream delegation contracts.
**They do not prove live login/inference, actual billing, real expiry-boundary
refresh, cross-process persistence safety, tool/image round-trips, or compaction.**
Earlier live observations of private prototypes do not verify this package.

## Troubleshooting

- Missing provider: check `pi list`, resource filters, and restart Pi or `/reload`.
  A provider absent from `--list-models` may simply have no available credential;
  Pi hides credential-less extension providers from that listing.
- Duplicate provider: disable the old standalone extension or duplicate install.
- Login expired/denied: restart `/login`; do not reuse authorization codes.
- Uncertain exchange/refresh: a single-use grant may already be consumed. The
  transport does not automatically retry; sign in again when needed.
- 403/model/quota errors: check provider-side access and account usage. Error
  text alone is not proof of a billing cause or a reason to enable extra charges.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), and
[security reporting](SECURITY.md). Never submit raw captures, account exports,
credentials, browser authorization strings, or session transcripts.

## License

[MIT](LICENSE). Independent project. Product names belong to their owners.
