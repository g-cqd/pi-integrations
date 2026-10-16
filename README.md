# pi-integrations

Modular provider integrations for [Pi](https://github.com/earendil-works/pi),
with reusable authentication components and **Bun-based development**.

One package, five independently loadable domains. **Every domain signs in
through `/login`; none accepts API-key configuration.**

| Domain | Pi provider ID | Sign-in | What the service returns |
| --- | --- | --- | --- |
| [Claude](docs/domains/claude.md) | `claude-subscription` | Browser authorization + pasted `code#state`, PKCE | OAuth access and rotating refresh tokens |
| [Codex](docs/domains/codex.md) | `codex-subscription` | ChatGPT sign-in via the Codex CLI client: browser (loopback or pasted redirect) or device code | OAuth access and rotating refresh tokens |
| [Antigravity](docs/domains/agy.md) | `agy-subscription` | Google sign-in with a pasted authorization code, PKCE (needs the Antigravity app's OAuth client secret, supplied locally, see the doc) | OAuth access and refresh tokens, plus a Cloud Code project |
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
The package explicitly lists the five domain entry points in `package.json`.
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

- **Claude Subscription (experimental)** — follow the link and paste the full
  `code#state` from that attempt.
- **Codex Subscription (experimental)** — pick browser or device-code sign-in with
  your ChatGPT account. This is the Codex CLI's sign-in, not the "Sign in with
  ChatGPT" token-sharing login that Pi's `openai` provider offers.
- **Antigravity Subscription (experimental)** — follow the link, then paste the
  authorization code from the final page. The Antigravity domain needs the app's
  OAuth client secret from the environment or a local file first; see its doc.
- **Spettro Subscription** — finish browser sign-in; Pi polls the device session.
- **Mistral Vibe (experimental)** — finish browser sign-in; Pi polls and performs
  the PKCE-bound API-key exchange. It does not read Vibe's Keychain.

Then run **`/model`** and select a model under the corresponding provider ID.

Claude, Codex and Mistral/Vibe use Pi's bundled model catalogs, not
account-specific entitlement lists; the Mistral domain offers only
**Mistral Large 4**. Spettro and Antigravity read their model lists from the
signed-in account. Their initial catalog placeholders are not inference models
and cannot be sent.

## Shared components, domain-specific protocols

```text
src/
  shared/                 reusable primitives; no provider endpoints
    http.ts               bounded HTTP reads, deadlines, safe errors
    urls.ts               HTTPS/origin/path validation
    pkce.ts               fresh S256 verifier/challenge pairs
    polling.ts            deadlines, cancellation, injectable clock/delay
    credentials.ts        validation, token expiry margin, API-key bookkeeping
    jwt.ts                read a claim from an issued token (never verifies)
    loopback.ts           one-shot OAuth callback server + callback/paste race
    sse.ts                bounded Server-Sent Events reader
    index.ts              public shared-component exports
  domains/
    claude/               authorization-code OAuth + refresh/revoke helpers
                         + subscription inference gate and protocol-drift
                         diagnostics (see docs)
    codex/                ChatGPT sign-in (browser or device code) + refresh
    agy/                  Google sign-in, Cloud Code project/model discovery,
                         and a dedicated cloudcode-pa inference stream
    spettro/              device login + live model discovery
    mistral-vibe/         browser PKCE process + API-key exchange
test/
  shared/                 primitive behavior and adversarial inputs
  claude/                 OAuth flow, response validation, inference gate
  codex/                  sign-in protocol and login state machine
  agy/                    sign-in, Cloud Code client, stream assembly
  spettro/                login, catalog, and compatibility behavior
  mistral-vibe/           complete browser-sign-in state machine
  pricing/                official-price parsers and comparison
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

- It does not run Claude Code, Codex, `agy`, Vibe, or Spettro as subprocess agents.
- It accepts no API keys: no domain reads a key or token from the environment
  or declares an `apiKey`. `SPETTRO_API_URL` and `AGY_API_URL` only select an
  endpoint. The Antigravity app's OAuth client secret is supplied locally (an app
  credential, not a user token; `AGY_OAUTH_CLIENT_SECRET` or the default file path).
- It does not use the Claude Agent SDK or claim first-party client identity.
- Claude includes the subscription inference gate: the canonical identity
  line becomes the only system block and the harness prompt is relocated into
  user messages (see [the Claude domain doc](docs/domains/claude.md)). **This
  works around a server-side check on third-party harness prompts.** It does not
  raise account limits or forge Claude Code attribution, but it can conflict with
  the provider's terms for subscription use; that risk is yours to assess.
  Client-identity headers are applied by Pi's bundled implementation for
  `sk-ant-oat` tokens; this package adds no header overrides of its own.
- It does not change account permissions or promise subscription billing, and
  it does not retry or reroute a request the provider rejects for quota.
- Claude, Codex, Spettro and Mistral delegate inference to Pi: Pi owns
  conversion, wire headers, streaming, tools, and usage reporting, and delegation
  does not mean those behaviors were independently verified here. **Antigravity is
  the exception:** Pi's Google adapter cannot be used, so that domain builds the
  request with Pi's exported helpers and streams `cloudcode-pa` itself.

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

Prices inherited from Pi's catalogs can be re-checked against the vendors'
official pages with `bun run verify:pricing` (network; see [pricing](docs/pricing.md)).
Notes on Codex and Antigravity sign-in are in
[the login investigation](docs/investigations/codex-and-agy-login.md).
[Harness proxy](docs/harness-proxy.md) explains how those protocol claims were
established from real agent traffic, and how to redo that safely.

Domain commands: `bun run test:claude`, `bun run test:codex`, `bun run test:agy`,
`bun run test:spettro`, `bun run test:mistral-vibe`, `bun run test:shared`,
`bun run test:contracts`.

Offline registration smoke test. Pi lists a provider only when it has a
credential, and these domains accept no API-key configuration, so the script
writes synthetic OAuth credentials into a throwaway Pi config directory (never
`~/.pi`) and checks that all five domains register. It makes no network request:

```sh
./scripts/smoke-registration.sh
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
- Antigravity reports a missing client secret: set `AGY_OAUTH_CLIENT_SECRET` or put
  it in `~/.config/pi-integrations/agy-oauth-client-secret`.
- Antigravity reports `invalid_client` at the token step: that secret does not pair
  with this client, so supply the value that does.
- Codex browser sign-in asks you to paste a redirect URL: port 1455 was busy
  (the Codex CLI uses it too). Paste the full `http://localhost:1455/...` URL
  from the browser's address bar, or choose device-code sign-in.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), and
[security reporting](SECURITY.md). Never submit raw captures, account exports,
credentials, browser authorization strings, or session transcripts.

## License

[MIT](LICENSE). Independent project. Product names belong to their owners.
