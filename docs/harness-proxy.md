# Harness proxy: verifying protocol claims against real agent traffic

How to observe what a coding agent actually sends and receives, so claims about
a provider protocol come from evidence instead of guesses. This is the method
behind the protocol notes in `docs/domains/*.md` and
`docs/investigations/codex-and-agy-login.md`.

**Scope and consent.** Only intercept traffic for accounts and machines you own,
for the purpose of understanding a protocol you intend to reimplement. Review the
provider's terms first: a first-party client identity used outside its own
application is a terms question, not a technical one, and no amount of clean
captures changes that.

## 1. Why a proxy

A domain here encodes a protocol: endpoints, query parameters, header sets,
request envelopes, response shapes. Reading a binary gives you constants; a proxy
gives you what the real client *does*, including things no documentation states
(which beta flags a request carries, which field the backend actually requires,
which error a malformed field produces). Every "verified" claim in the domain docs
should be traceable to a capture or to the shipped client's own source.

## 2. Two capture modes

Pick per question. Prefer the cheap one.

| Mode | Use when | Cost |
| --- | --- | --- |
| **Binary/schemas** (strings, protobuf descriptors) | you need endpoints, enums, field names, defaults | seconds, no traffic |
| **Request log** (run one real turn, read what the agent logged) | you need the host, the method path, the sequence | one cheap inference |
| **TLS interception** (mitmproxy) | you need bodies: envelopes, headers, error payloads | breaks TLS; needs a trust change |

Order matters. Most questions are answered by the first two. Interception is the
last resort, and it is the only mode that touches credentials, so it has the
strictest handling rules below.

### 2a. Binary and schema extraction

```
strings "$(command -v agy)" | grep -oE 'https://[a-z0-9.-]+(/[A-Za-z0-9_{}=*/$.:-]+)*'
strings "$(command -v codex)" | grep -E 'oauth/(authorize|token)|/backend-api'
```

Embedded protobuf `FileDescriptorProto` blobs can be decoded without `protoc` by
reading the wire format directly: a `FileDescriptorProto` is length-delimited, and
its `name` field (tag 1, wire type 2) is the `.proto` path, which locates the blob
in the binary. Parsing `message`/`enum`/`service` fields yields field numbers,
types, and HTTP annotations. For the Antigravity domain this produced the
`v1internal` envelope, the project-lookup request, and the model-list schema
without any live traffic.

### 2b. Request-log capture

Run one trivial turn on the cheapest model with the agent's own logger enabled,
then read the URLs it printed. For `agy` this gave the host
(`daily-cloudcode-pa.googleapis.com`), the three `v1internal:` methods, and the
call order, for one token's cost. Model choice matters: use the smallest model and
the shortest prompt; you are buying visibility, not output.

### 2c. TLS interception (highest care)

The prototype used a container whose egress went through a host-side mitmproxy,
with the proxy CA added to the *container's* trust store only.

Why a container: a container has an isolated filesystem and its own CA handling.
`NODE_EXTRA_CA_CERTS` (Node), `SSL_CERT_FILE` (curl, Python), and the system store
point at one file, so no host trust store is modified. macOS system trust is
protected by design and should stay that way; Go binaries ignore `SSL_CERT_FILE`,
so some tools cannot be intercepted without a trust-store change. When that is the
only remaining option, do it in a throwaway VM, never on the daily driver.

Shape of the setup:

```
host: mitmdump -s addons/<capture>.py --listen-port 8080
container: HTTPS_PROXY/HTTP_PROXY -> host.docker.internal:8080
           NODE_EXTRA_CA_CERTS=/opt/<proxy-ca>.pem
           HOME=<isolated dir>          # no real credentials, no real config
```

Rules that make this safe enough to do at all:

- **Isolated home.** The agent starts with an empty config directory, so you never
  sign in as yourself by accident and never read your own token store.
- **Do not complete a sign-in under interception** unless you must, and prefer the
  isolated profile when you do. If a capture needs an authenticated turn, treat the
  resulting files as live credentials (below).
- **Never commit the container's credential file or the trust anchor.** Both are in
  `.gitignore` for this reason, and a container state directory holding tokens
  should be deleted rather than kept.

## 3. Redaction: the non-negotiable part

An interception capture is a credential dump. `~/.codex/auth.json` and
`claude-home/.credentials.json` hold rotating refresh tokens; flow files of agent
turns contain `Authorization: Bearer` headers and full prompt and tool payloads.
In the prototype's capture directory, 406 of 463 flow files contained a live
subscription token. That is the normal ratio for a busy session, not an accident.

Treat captured material as a secret with a lifetime:

- **Never commit** captures, container state, CA files, or agent credential files.
- **Never paste raw captures** into a PR, an issue, or this repository. Extract the
  three or four facts you need (a URL, a field name, a status code) and cite them.
- **Prefer non-authenticated probes** for protocol questions. An anonymous bogus
  request often answers the same question: Google's token endpoint said
  `client_secret is missing` without a secret, and its authorize endpoint revealed
  which redirect URIs and clients are acceptable, with no account involved.
- **Redact before you display.** Provider error messages echo tokens back in some
  cases. This package's diagnostics strip `ya29.`, bearer, `GOCSPX-`, and
  `sk-ant-` shapes before anything reaches a log or an error (see
  `src/domains/agy/cloudcode.ts`), and the test suite asserts it.

## 4. From claim to evidence

For each claim a domain doc makes, record where it came from. The Antigravity doc
carries this as a table; the categories in practice are:

- **Captured:** the authorization URL (from the CLI's own output), the inference
  host and method paths (from its request log).
- **Anonymous probe:** a requirement such as "this client needs a secret" or "the
  device flow is not enabled", established with a bogus request.
- **Schema:** the request/response shape, from an embedded descriptor.
- **Unverified:** anything else, especially identity fields that cannot be observed
  without authenticating as the app. Say so in the doc rather than implying it.

A protocol that can change without notice makes this a living document: re-capture
when a claim breaks, and prefer describing a mechanism ("the SDK throws on non-2xx
before `onResponse` runs") over a snapshot of a payload.

## 5. Debugging checklist

When a domain stops working, in the order that resolves most failures fastest:

1. **Is the request shaped as expected?** Compare against the captured envelope:
   project, model id, request type, identity fields.
2. **Is the response a 4xx with a Google/Anthropic status code?** Read the code
   (`PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `UNAUTHENTICATED`) before the text.
3. **Is the account entitled?** Tier and project come from the provider's own
   account lookup, not from a guess; a missing project is an onboarding problem.
4. **Is the host right?** Production and daily/preprod hosts differ; the CLI's own
   traffic decides which one is real.
5. **Re-bisect one variable at a time.** The Claude gate rules were established this
   way: change exactly one field per request and record the status.

## 6. Cleanup

After a capture session, delete rather than archive:

- flow files and request logs,
- container state and any tarball of it,
- the trust anchor,
- the container and image (`docker image rm` once you no longer need the build).

Keep the *conclusions* (this file, the domain docs, the investigation notes) and
discard the *evidence* (the traffic). The evidence has an expiry and a blast
radius; the conclusions have neither.