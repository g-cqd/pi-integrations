# Spettro domain

Provider ID: `spettro`. Login label: **Spettro Subscription**.

Ports the existing personal Pi extension into a testable domain:

1. POST `/auth/initiate` with a fresh session UUID.
2. Open the returned HTTPS browser link.
3. Poll `/auth/poll/<session>` until pending becomes complete or expired.
4. Store the returned device API key through Pi.

The flow is cancellable and bounded to ten minutes, with individual HTTP
requests bounded to thirty seconds. There is no implemented API-key refresh
endpoint: the compatibility refresh callback retains the key.

The legacy credential shape duplicates the device key in its refresh field.
That is **not an independently usable refresh token**. The distant storage
expiry is bookkeeping only; provider revocation can invalidate the key earlier.

Model discovery uses authenticated GET `/v1/models`. Invalid/duplicate entries
are filtered; malformed catalog envelopes fail. Vision/reasoning require actual
boolean true flags. Missing/invalid context size defaults to 128000; max output
defaults to 8192. These defaults are not verified service limits.

A refresh that cannot run (offline mode, missing/invalid credential, or an
empty catalog) returns the placeholder entry instead of an empty list: Pi
publishes whatever `refreshModels` returns as the whole model list, and an
empty return would erase the provider from `/model` until the next
successful refresh. The placeholder is never sendable as an inference model.

The catalog has no price metadata handled here, so costs are represented as
zero, meaning **unknown/untracked**, not free inference. The loading placeholder
is rejected before streaming.

Models set `supportsDeveloperRole: false` for the backend's classic system-role
compatibility. This is not the Claude prototype's relocation of instructions
into user messages.

Default API origin: `https://api.spettro.app`. Optional `SPETTRO_API_URL`
selects a custom API base; it must be HTTPS or explicit HTTP loopback for local
development. It receives authentication traffic and any stored key, so trust
the configured destination. `SPETTRO_API_KEY` is an optional key fallback.

This package does not read or modify `~/.spettro/keys.enc`. Live behavior of
the newly modularized implementation remains to be verified separately.
