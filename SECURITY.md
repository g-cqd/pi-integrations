# Security

This is experimental software, not an audited authentication client.

Use [GitHub private vulnerability reporting](https://github.com/g-cqd/pi-integrations/security/advisories/new).
Do not open public issues containing credentials, authorization strings, private
account information, raw captures, or provider response bodies.

Report the affected revision, expected/observed behavior, and a minimal
reproduction using synthetic data. No response-time or support-lifetime
commitment is currently offered.

## Boundaries

- Pi extensions run with the user's operating-system permissions.
- Pi owns credential persistence. The default auth store is plaintext.
- All domains use the shared HTTP boundary: redirect refusal, 30-second request
  signal, 1 MiB response-byte limit while reading, and sanitized transport errors.
- Injected fetch implementations must honor cancellation. The cap does not
  constrain allocations already performed by the underlying runtime.
- Polling rejects results arriving after its deadline, honors cancellation, and
  does not automatically retry terminal or uncertain exchanges.
- Provider-owned schemas remain separately validated. Shared helpers are not a
  substitute for authorization, endpoint validation, or least-privilege consent.
- Claude's requested permissions are broad and not minimized.
- No domain accepts API-key configuration. Spettro and Mistral/Vibe still *receive*
  a service-issued key at sign-in, which Pi stores like any credential.
- Codex binds a one-shot callback server on `127.0.0.1:1455` during browser sign-in:
  exact path only, loopback `Host` only, state-checked, first valid callback wins,
  static pages. Antigravity binds no port.
- The Antigravity app's OAuth client secret is **never committed, in any encoding**.
  It is read at run time from `AGY_OAUTH_CLIENT_SECRET` or
  `~/.config/pi-integrations/agy-oauth-client-secret` (`AGY_OAUTH_CLIENT_SECRET_FILE`
  overrides the path), and a test fails if the tree contains a secret-shaped literal.
  It is never stored in credentials, logged, or echoed, and provider messages are
  redacted of tokens.
- Spettro custom API bases receive authentication traffic and stored API keys.
  Only use destinations you trust. Browser links must be HTTPS but Spettro's
  returned browser hostname is not currently pinned to an allowlist.
- Mistral/Vibe returned browser/poll URLs are restricted to the configured
  Console origin/path. No Keychain or Vibe credential files are read.
- API-key compatibility timestamps are bookkeeping, not server-issued lifetimes.
- Refresh persistence and cross-process recovery are delegated to Pi and not
  independently verified here.
- Pi's inference conversion, headers, event streams, usage estimates, and
  provider-side access/billing decisions are outside this implementation.
- This package contains no capture archives, account exports, or production
  credential fixtures. Do not add them in reports or contributions.

If a credential is exposed, remove it from logs/history and revoke it through
the provider's supported controls where available. Deleting a local file or
running Pi's /logout alone does not prove server-side revocation.
