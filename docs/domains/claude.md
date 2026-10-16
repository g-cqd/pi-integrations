# Claude domain

Provider ID: `claude-subscription`. Login label: **Claude OAuth (experimental)**.

Uses browser authorization with PKCE S256, a mandatory matching state in the
pasted response, JSON code exchange, and rotating refresh credentials.
Authorization: `https://claude.com/cai/oauth/authorize`.
Exchange/refresh: `https://platform.claude.com/v1/oauth/token`.
The code-level revoke helper targets that endpoint's `/revoke` path; Pi logout
does not invoke it.

Constants originated in a local investigation of Claude Code 2.1.301, not a
published third-party OAuth contract. The public client ID belongs to the
existing application, not an app separately registered for this project.

Requested permissions are broad and **not minimized**:

```text
org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins
```

Review consent before proceeding. The adapter validates returned scope as a
string; it does not establish an inference grant merely from a successful login.
Returned credentials may include email, organization name, and scope metadata.

Optional environment variables:

- `CLAUDE_SUBSCRIPTION_ORG_UUID`: organization hint for the next sign-in.
- `CLAUDE_SUBSCRIPTION_LOGIN_HINT`: email hint for that URL.
- `CLAUDE_SUBSCRIPTION_ACCESS_TOKEN`: access-token-only fallback, no refresh token.

Pi's bundled Anthropic catalog and Anthropic Messages streamer are reused.
List-price estimates are not actual subscription charges. This domain does not
include the private prototype's first-party identity/prompt-role transformations.
That prototype's successful live turns do not establish this version's acceptance.

Expiry uses the validated server lifetime minus the smaller of five minutes or
10% of that lifetime. The adapter returns replacement refresh credentials;
Pi owns persistence and coordination. End-to-end refresh at actual expiry,
concurrent refresh recovery, and live inference remain unverified here.
