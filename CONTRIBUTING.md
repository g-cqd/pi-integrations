# Contributing

Use Bun 1.4.3 and the committed bun.lock:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test
bun run test:coverage
```

The domain suites can be run independently through test:claude, test:codex,
test:agy, test:spettro, test:mistral-vibe, test:shared, and test:contracts.
Run `bun run verify:pricing` (network) after touching a model catalog.

Use red-first tests and synthetic fixtures. Do not make real provider requests
or access local credential stores in automated tests/CI. Never commit captures,
account exports, tokens, browser authorization strings, session transcripts,
or local Pi configuration.

Two consequences for the `agy` secret, which is a live credential of the app:

- Tests must inject the file reader. A resolver called without one reads the
  real `~/.config/pi-integrations/agy-oauth-client-secret`, so a developer who
  followed the documented setup would see unrelated tests fail, and a local
  credential would leak into test output.
- `scripts/extract-agy-client-secret.ts` is an operator tool, not a test. It makes
  a real token-endpoint request by design, so it is deliberately outside CI and
  outside the test suites. Its search rules are pure and live in
  `scripts/extract/candidates.ts`, where `test/agy/extract-candidates.test.ts`
  covers them with synthetic, secret-shaped fixtures.

## Code boundaries

- Add protocol behavior to its domain, not to another domain.
- Reuse shared HTTP, PKCE, URL validation, polling, and credential primitives
  where the semantics match. Do not create a universal auth abstraction merely
  to hide differences between OAuth and API-key protocols.
- Keep provider factories dependency-injected. Runtime imports/registration
  belong in each domain's small index.ts.
- Use the sequence-fetch, callback, and virtual-clock fixtures in test/support.
- Add both domain regressions and shared-contract tests when changing a boundary.
- A response body that closes on its own cannot expose an unbounded read, so
  cancellation and stalled-body tests use a stream that is deliberately left
  open; see `test/shared/http-abort.test.ts`.
- When a test guards a hang or a boundary, revert the fix and confirm the test
  fails. A test that passes both ways proves nothing.
- Delegate inference to Pi; do not add first-party identity claims, prompt-role
  relocation, or access/billing-bypass workarounds.
- Preserve provider IDs and other users' existing provider configurations.

For behavior changes, explain the failure and distinguish mocked evidence,
public-source protocol observations, and live measurements. Successful login
does not establish inference entitlement or subscription billing.

`test/package/contracts.test.ts` asserts what Pi actually receives from each
`index.ts`: a complete provider config, `streamSimple` returning a real Pi event
stream, and the placeholder models refusing to infer. A provider can register
successfully and still be unusable at inference time.

See [architecture](docs/architecture.md) for adding a domain. Keep pull requests
focused; report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
