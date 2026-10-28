# Copilot — VS Code-style (experimental)

This independent domain investigates a standalone Pi connection using the observable VS Code Copilot lifecycle, rather than Pi's built-in `github-copilot` authentication. It does not require VS Code to be running and does not read VS Code credentials. The provider ID is **`copilot-vscode`**; the built-in provider is unchanged.

**Evidence level: public-source inspection and synthetic tests, plus user-reported successful live connection/inference.** The coding-agent validation has not independently exercised an authenticated account, quota display or billing. Matching request headers does not establish that GitHub accepts Pi as VS Code, applies the same quotas, or authorizes the same models. This is not exact VS Code parity or an officially supported client.

## Try it

From this checkout, load the domain directly:

```sh
pi -e ./src/domains/copilot/index.ts
```

The package manifest also loads it by default. Inside Pi:

1. Run `/login` and select **Copilot — VS Code-style (experimental)**.
2. Open the GitHub device verification URL shown by Pi and enter its one-time code. Review the OAuth application and requested permission before approving. Never paste the resulting grant/token into a chat or issue.
3. After catalog refresh, use `/model` to select a model under `copilot-vscode`.
4. For initial validation, use a harmless prompt such as “Reply with OK”, with no workspace data or tools.

The `copilot-catalog-loading` entry is only a placeholder; it refuses inference. If no account models appear, check authentication and refresh/restart Pi with network catalog refresh allowed. There is no guessed static model fallback. A successful sign-in does not prove inference entitlement. A `403`/`429` remains authoritative; this domain never enables a model policy automatically.

Review GitHub's current terms before use. Known model prices use GitHub’s own Copilot USD-per-million-token table, including long-context tiers. Unknown model prices still use zero-valued Pi fields because the schema requires numbers; **those fields do not mean inference is free**. Copilot-specific quota probing is not implemented, so the decision router cannot account for its live quota headroom.

## Pricing and keeping it current

GitHub’s current billing documentation distinguishes **usage-based AI credits** (1 credit = $0.01 USD) from **legacy premium request multipliers** for some existing annual plans. Vendor API prices, Copilot token prices, premium requests and dollar credits are not interchangeable. Pi’s session cost is an estimate at Copilot list rates—not an authoritative debit from your account. Promotions, plan discounts, billing-entity policies and server usage accounting can change the actual charge.

- `prices.json` is the offline fallback generated from the official [GitHub Copilot pricing table](https://github.com/github/docs/blob/9568e964d18d76267faf57050dc662c450a13214/data/tables/copilot/models-and-pricing.yml), revision `9568e964d18d76267faf57050dc662c450a13214`. The table has 28 unambiguous model IDs, with tiered rates where published; the separate Opus fast-mode entry is intentionally not applied to ordinary Opus requests.
- During an allowed network catalog refresh, the extension also refreshes the public `main` pricing table, at most once per day per process. Requests are credential-free, redirect-refusing, bounded to 5 seconds and the shared size limit, and coalesced. Failed/changed-format responses leave the previous verified table intact; failures are cached too to avoid repeated delays. No timer or pricing request runs at registration or in offline catalog mode.
- The newly priced account catalog persists through Pi’s existing models store, so offline restarts retain the saved quotes. Runtime refresh timestamps are in-memory, so a new process can check again. Refreshing prices does not rewrite historical session usage.
- Prices match exact normalized model IDs; unknown aliases and dated variants are not guessed. Expired promotional entries are unavailable on newly priced catalogs until a verified replacement is published. Previously saved offline catalogs can still carry old quotes: refresh online before relying on a saved quote.
- `bun run verify:copilot-pricing` compares the checked-in snapshot to the pinned official revision. `bun scripts/copilot-pricing.ts --write` regenerates it; change the pinned revision deliberately when maintaining the fallback. Live runtime refresh uses `main`, not the pinned revision.

References: [models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing), [legacy annual-plan multipliers](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/model-multipliers-for-annual-plans), and the pinned repository’s `data/variables/product.yml` for the credit-dollar conversion.

## Usage status line

The extension adds a `copilot-usage` status slot without replacing Pi’s footer or other extensions. It is shown when the selected model belongs to `copilot-vscode`:

```text
Copilot [#######---] ~750/1000 used · ~250 left
```

The bar fills with **used** allowance. Green means more than 25% remaining, yellow means 10–25%, red means 10% or less. Unlimited allowance has a separate display. Overage count and whether overages are enabled are shown when reported. Numeric `~` values are approximate: VS Code derives them from the server’s rounded remaining percentage. This is an account allowance snapshot, not this Pi session’s token total.

Snapshots come from `x-quota-snapshot-premium_models`, `x-quota-snapshot-premium_interactions`, or `x-quota-snapshot-chat` response headers, following the inspected VS Code quota service. Legacy snapshots are labeled `requests`; free chat snapshots are labeled `chat`. The generic `premium_models` header is intentionally not relabeled as dollar credits without verified account-specific unit semantics. The display never estimates an account balance by subtracting local token costs or model multipliers.

Before a qualifying response, or after missing/malformed quota headers, the display reads **Copilot usage unavailable**. Snapshots older than five minutes are marked **stale** at the next UI event; there is no polling timer. A new login invalidates the previous account snapshot. Noninteractive sessions do not call the UI. Some custom footers may choose not to render extension statuses. Header availability, units and visual appearance still need validation on a live account; there is no extra credential-store read or quota request.

## Error handling

- 401 suggests `/login`; 402 points to billing/budget; 403 points to entitlement or organization/model policy; 429 points to quota/rate limits; 5xx suggests a service outage. Error descriptions and arbitrary response headers are not forwarded. Only a validated numeric `Retry-After` is retained, with a new JSON content type.
- Error-body cancellation is best-effort and not awaited; a rejecting or stalled cancellation hook cannot block/replace the HTTP error. Raw transport exceptions are sanitized; caller cancellation remains cancellation.
- Automatic SDK inference retries are disabled (`maxRetries: 0`), even if callers request retries. This avoids silently replaying potentially billable requests. Pi’s higher-level retry behavior is separate and is not replaced here. There is no automatic identity/policy change, model downgrade or 401 replay.

## Connection lifecycle

```text
GitHub device approval (VS Code's public OAuth client ID, user:email scope)
  -> GitHub OAuth grant, stored through Pi's credential store
  -> GET api.github.com/copilot_internal/v2/token
  -> short-lived Copilot token + server-selected API endpoint + refresh timing
  -> GET <API endpoint>/models
  -> model-specific streaming endpoint
```

- Device authorization uses `/login/device/code` and `/login/oauth/access_token`, bounded polling, `authorization_pending`, `slow_down`, expiry and cancellation. The minimum Copilot scope is `user:email`; broader repository/workflow scopes are not requested.
- Copilot token exchange uses `Authorization: token <GitHub grant>`. Inference uses **only** `Authorization: Bearer <Copilot token>`; it never sends the GitHub grant to model endpoints.
- Pi owns credential persistence and refresh coordination. `refresh_in` determines the local refresh deadline, rather than assuming that the server's `expires_at` shares the local clock. Refresh exchanges the retained GitHub grant for a new Copilot token, preserving the generated identity.
- The API endpoint comes from `endpoints.api`, falling back to `https://api.githubcopilot.com`. Only HTTPS root origins on `githubcopilot.com` or its subdomains are accepted. The token's `proxy-ep` string is not parsed. Enterprise/custom GitHub origins are not supported.
- Catalog discovery is account-specific. Only picker-enabled streaming chat models with tools are offered; disabled policies and unsupported protocols are excluded. Responses is preferred, then Anthropic Messages, then Chat Completions. Unlike VS Code, this experimental domain does not configuration-gate Messages. WebSocket-only models are excluded.
- Catalogs persist without credentials and restore offline. An empty successful catalog replaces stale entries. The inference origin is always pinned to the current credential, not to a persisted model's URL; requests refuse redirects.
- Inference adds source-derived editor/plugin/integration headers, installation/session identifiers, a fresh request ID, `OpenAI-Intent: conversation-agent`, `X-Initiator: user|agent`, and the image-request marker where applicable. Installation identifiers are randomly generated at login, not copied from VS Code.

### Why use a private Pi API ID?

All exposed models use `copilot-vscode-chat`. Pi's extension composer invokes a custom streamer only when the model API matches the provider API; directly exposing a mix of native API names would bypass our auth wrapper for some models. The native protocol is kept in an internal catalog and persisted for offline restoration. The wrapper selects the appropriate generic Pi Responses, Messages, or Completions adapter after unpacking the credential and pinning the endpoint.

The packed string passed through Pi's string-only extension auth bridge contains the Copilot token, API origin and installation identity—not the GitHub grant. It must still be treated as a credential. Generic adapters handle message/tool conversion, SSE, usage and callbacks. They are not Pi's built-in Copilot connection.

## Source baseline

The following public revisions were inspected; this is a reproducible source baseline, not a claim about the installed VS Code or current server behavior:

| Repository | Revision | Relevant sources |
| --- | --- | --- |
| [microsoft/vscode](https://github.com/microsoft/vscode/tree/171e90619c723a84a3e1c7bcd58d226698f55c72) | `171e90619c723a84a3e1c7bcd58d226698f55c72` | `extensions/github-authentication/src/{config,flows,githubServer}.ts`: public OAuth client ID, scopes and device flow |
| [microsoft/vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat/tree/5863f5a7088958050792b5dccbe8b46c6e13eccc) | `5863f5a7088958050792b5dccbe8b46c6e13eccc` | `src/platform/authentication/{vscode-node/session,node/copilotTokenManager,common/copilotToken}.ts`; `src/platform/endpoint/{node/domainServiceImpl,common/endpointProvider,node/chatEndpoint,common/capiClient}.ts`; `src/extension/prompt/node/chatMLFetcher.ts` |

Headers use the inspected Copilot Chat package version `0.44.0` and its VS Code engine baseline `1.115.0`. These constants are not detected from a user's installation and must not be interpreted as a compatibility guarantee.

The inspected VS Code implementation depends on `@vscode/copilot-api`, whose published license restricts use to specified VS Code contexts and reserves integration identities. **This project does not depend on that package, extract signing material, or implement its private signing path.** Publicly visible field names and an OAuth client ID are not permission to use a reserved production identity and do not reproduce any server-side trust decision. Review applicable terms and obtain any required authorization before deployment.

## Known differences and remaining validation

- Only device sign-in is implemented, not VS Code's browser authentication/session service. A fresh login generates new installation identifiers; these are not VS Code's installation-wide identifiers. Session IDs use the Pi session option when supplied, otherwise the provider-runtime ID.
- Refresh is request-driven by Pi, which can refresh early for its validity margin. There is no background refresh timer or explicit 401-triggered reauthentication/replay loop here.
- Generic Pi request bodies, tools, prompts and thinking controls differ from VS Code's chat stack. VS Code interaction telemetry, experiments, prompt construction, model/auto-session selection, WebSockets and all private client signatures are not reproduced.
- Messages support is implemented but not live-validated. Account policy, organization restrictions, billing classification, premium request accounting and model eligibility have not been measured.
- Automated tests prove local behavior with synthetic grants, envelopes, catalogs and streams. They do not independently verify live account acceptance, visual rendering, quota units or billing. The user reports that the initial live connection works; this is narrower evidence than billing parity.

## Safe live comparison / proxy plan

A proxy is **not needed for the first login and minimal inference attempt**. If a comparison with VS Code is necessary:

1. Agree on the scope first. Do not silently change system proxy settings, install a CA, read credential stores, or intercept unrelated applications. Prefer a dedicated local test session and narrowly scoped process proxy, if supported by both clients.
2. Use the same authorized account/model and an identical synthetic prompt, without repository context. Compare login, token renewal, catalog lookup, first user turn and tool-follow-up handling separately.
3. Record only allowlisted metadata: method, hostname, path without query, HTTP status, protocol choice, timing, header **names**, authentication scheme/presence, and whether request/session IDs stay stable or change. Do not record header values, URLs containing codes, raw token envelopes, prompt bodies, account identifiers, model catalogs containing account metadata, or SSE transcripts.
4. Never bypass TLS validation or extract signing keys. Stop on policy/entitlement errors rather than probing alternate identities. Remove temporary routing/trust changes afterwards.
5. Keep raw captures out of this repository. Publish only reviewed, redacted observations; promote a claim from source-derived to measured only after that comparison succeeds.

Run `bun run test:copilot` for isolated tests. `test/copilot/harness.test.ts` exercises real Pi runtime dispatch; `stream.test.ts` exercises the three real generic SDK stream adapters with synthetic SSE.

## Tests and mutation testing

`bun run test:copilot` includes synthetic lifecycle, pricing, malformed input, quota parsing, status lifecycle, and real Pi runtime/SDK adapter tests. HTTP 401/402/403/429/500 are exercised through all three native transports. Tests never read real credentials or perform authenticated network requests.

`bun run test:copilot:mutation` runs a **curated fault-injection campaign**, not an exhaustive Stryker/AST mutation score. It copies the Copilot source, shared primitives and synthetic tests into a temporary directory, links existing dependencies, verifies the baseline, injects each named fault independently, and removes the directory in `finally`. Syntax/module errors and timeouts are reported as invalid, not kills. The original checkout is never mutated. Targets include endpoint trust, redirects, token timing, catalog eligibility, native dispatch, error sanitization, cancellation, retry policy, pricing, quota arithmetic/colors and status lifecycle. A survivor fails the command and must be investigated.
