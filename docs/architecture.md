# Architecture and reusable components

The package has three Pi extension entry points. Each domain registers exactly
one distinct provider and can be filtered out without preventing the others
from registering. Shared modules contain no provider endpoints or persistent
credential state.

## Reusable exports

The `pi-integrations/shared` package subpath exports:

| Primitive | Responsibility |
| --- | --- |
| `requestText` | Injectable fetch, 30-second request signal, redirect refusal, bounded response reading, safe transport errors. Returns status-bearing response metadata plus text for domain parsing. |
| `requestJson` | Builds on requestText, rejects non-success HTTP statuses with HttpStatusError, parses JSON without echoing bodies. |
| `RESPONSE_LIMIT_BYTES` | 1 MiB maximum response bytes accepted by the transport. |
| `safeBaseUrl` | HTTPS API base validation; explicit HTTP loopback development is allowed. Rejects userinfo/query/fragment. |
| `browserUrl` | Validates an HTTPS browser link; does not impose a provider-specific origin. |
| `trustedUrl` | Restricts a browser/poll link to an expected HTTPS origin and path boundary. |
| `generatePKCE` | Fresh 32-byte RFC 7636 verifier and S256 challenge. |
| `pollUntil` | Generic pending/complete orchestration, cancellation, deadlines, optional delayed first poll, rejection of late results. |
| `waitFor` | Cancellable production delay with listener cleanup. |
| `record`, `validSecret` | Small runtime validation helpers. |
| `apiKeyCredentials` | API-key bookkeeping for Pi's legacy OAuth store; does not create a refresh token or real expiry contract. |

Example using the same production orchestrator with a virtual clock:

```ts
import { pollUntil } from "pi-integrations/shared";

let now = 0;
let polls = 0;
const value = await pollUntil({
  deadline: 100,
  intervalMs: 10,
  now: () => now,
  sleep: async (ms) => { now += ms; },
  poll: async () => ++polls === 2
    ? { state: "complete", value: "synthetic-result" }
    : { state: "pending" },
});
```

In production, omit clock/delay overrides and pass the operation's AbortSignal.
An injected fetch must honor that signal; no wrapper can force an arbitrary
non-cooperative replacement to settle. The response cap limits bytes retained
by this layer, not allocation already performed inside the transport runtime.

## Ownership boundaries

- Shared transport does **not** retry operations or interpret provider error
  bodies. Claude allowlists OAuth error codes in its own parser.
- Domains own endpoints, requested permissions, response schemas, and terminal
  errors. The common poller understands only pending and complete; providers
  interpret denied/expired/error states and throw before returning a result.
- Claude and Mistral/Vibe share PKCE generation. Both polling domains share
  the same timing/cancellation implementation. All domains use the same HTTP boundary.
- Pi owns persistence, model runtime, API conversion, event streams, pricing
  estimates, and scheduling refreshes.
- No singleton tokens, global login attempts, or domain-to-domain credentials
  are stored in this package.

## Test seams and contracts

`test/support/fixtures.ts` provides sequenceFetch, virtualClock, and
loginCallbacks. Fixtures contain synthetic values only.

The package contract suite checks isolated registration, combined registration,
distinct provider IDs, manifest entry points, unchanged transcript context,
and preservation of caller options/event-stream identity at the delegate seam.
It does not simulate the complete Pi streaming implementation or live provider.

## Adding a domain

1. Add `src/domains/<name>/provider.ts` with a dependency-injected configuration
   factory, and a small `index.ts` for Pi runtime imports/registration.
2. Choose a unique provider ID and document credential/billing semantics.
3. Reuse shared primitives only where the protocol actually matches. Do not
   force an API-key exchange into an OAuth refresh model.
4. Write failing flow/validation tests first; use shared synthetic fixtures.
5. Add the manifest entry and registration/delegation contracts.
6. Document observed protocol sources and unverified behavior.
7. Run Bun type-checks, all test domains, offline Pi registration, and a secret
   scan before publishing. Never use CI credentials or live sign-in as fixtures.

This is a focused internal component library, not an attempt to model every
authentication protocol behind one universal abstraction.
