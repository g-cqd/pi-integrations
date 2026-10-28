# Per-token pricing: sources, verification, and limits

Checked 2026-10-17 against each vendor's official price page. All figures are
USD per million tokens (MTok), the unit Pi's model `cost` uses.

## What the numbers mean here

- **Subscription sign-ins are not billed per token.** Claude, Spettro, and
  Mistral/Vibe sign-in costs shown by Pi are list-price API **estimates**, not
  charges. Spettro has no price metadata, so its costs are zero meaning
  "unknown", not "free".
- Pi's `cost` shape already carries everything a vendor publishes per model:
  input, output, cache read, 5-minute cache write, long-context `tiers`, and a
  derived 1-hour cache write (2x input). No new mechanism is needed; the work
  is keeping the data right.
- This package reuses Pi's bundled catalogs (`getModels("anthropic")`,
  `getModels("openai-codex")`, and `getModels("mistral")` in full) and does
  not override their costs. Antigravity has no static catalog: its models and
  limits come from the account, and its cost is zero meaning unknown.

## Re-verify at any time

```sh
bun run verify:pricing            # exit 1 only on a price difference
bun run verify:pricing --strict   # also exit 1 on unverified or time-limited rows
```

It fetches the official pages below, diffs them against the catalogs this
package uses, and prints match / differ / unverified / official-only per model.
It needs network access, so it is not part of `bun test`. The parsers and
comparison logic are covered offline by `test/pricing/parse.test.ts`.

| Provider | Official source (machine-readable) | Used by |
| --- | --- | --- |
| Claude | https://platform.claude.com/docs/en/about-claude/pricing.md | `claude-subscription` |
| Mistral | https://docs.mistral.ai/inference/pricing.md | `mistral-vibe` |
| OpenAI | https://developers.openai.com/api/docs/pricing.md | `codex-subscription` |

## Findings (2026-10-17)

**Claude: 17 match, 0 differ.** All 14 current models plus 3 dated snapshots
match, including the Haiku 5.5 tier above 100,000 prompt tokens and the
per-model cache-read multipliers (Fable 5.1 is 0.025x, Opus 5.5 and Sonnet 5.5
are 0.05x, everything else 0.1x). The six official rows absent from Pi are
retired or limited-access models (Mythos, Opus 4.1, Opus 4, Sonnet 4, Haiku 3.5).

**Mistral: 8 match, 0 differ, 32 unverified.** The unverified ids are mostly
`-latest` aliases and older or Labs models with no row on the current page.
Observations:

- `mistral-large-4` matches its **sale** price ($0.68 input, $2.09 output); the
  page lists the regular price as $1.36 / $4.18.
- The official API name for Medium 3.5 is `mistral-medium-3-5` (hyphen). Pi's
  catalog id is `mistral-medium-3.5` (dot), which is Vibe's *alias*; Vibe's own
  default `active_model` is the hyphenated form. Whether the API accepts the
  dotted form is **unverified** (it needs a Mistral key), so it is flagged and
  not changed.
- Vibe's own `/model-catalog` endpoint carries **no price fields** (only
  capabilities, parameters, and context length), so prices must come from the
  public page.

## Not representable in a per-model catalog

These apply per request, not per model, so a static `cost` cannot capture them:

- Batch (50% off), fast mode (premium on Opus 5.5, 5, 4.8), and US-only
  inference (`inference_geo: "us"`, 1.1x on all token categories).
- Tool and runtime charges (web search, code execution, managed agent sessions).
- Tokenizer differences: Claude 4.7 and later produce roughly 30% more tokens
  for the same text, so equal text costs more even at equal rates.

## Time-limited prices (a pinned copy goes stale)

| Vendor | Model | Now | Changes |
| --- | --- | --- | --- |
| Mistral | Large 4 | $0.68 / $2.09 sale | regular $1.36 / $4.18 (no end date listed) |
| OpenAI | GPT-5.6 Sol | promotional | "at least through November 21, 2026" |
| Google | Gemini 4 Argon | $2.00 / $10.00 | $4.00 / $20.00 from 2026-12-01 |
| Google | Gemini 3.8 Flash | $0.75 / $3.75 | $1.50 / $7.50 from 2027-01-01 |
| Anthropic | Sonnet 5 | $2 / $10 | introductory price became the standard price |

Pi's catalog currently reflects today's price for each of these. Pi's static
`cost` has no effective-date field, so entries must be refreshed when the
vendor's price changes; the verifier is how to notice.

## Codex (enforced)

**8 match, 1 unverified.** All eight verifiable models match OpenAI's standard table,
including the long-context tier above 272K tokens. `gpt-5.3-codex-spark` has **no
official row**, so its price cannot be verified. GPT-5.6 Sol is on promotional pricing
"at least through November 21, 2026".

## Mistral Large 4

The Mistral domain offers Pi's whole catalog; this section is about the
`mistral-large-4` row the verifier can match. Pi's catalog price for it
($0.68 input, $2.09 output, $0.07 cached input) is Mistral's current **sale** price;
the regular price on the same page is $1.36 / $0.14 / $4.18, and no end date is
listed. The verifier flags this as time-limited, and a catalog still on the regular
price during the sale is reported as a difference.

## Gemini (not enforced)

Antigravity does not use a static catalog, so Gemini prices are not verified here.
For reference, https://ai.google.dev/gemini-api/docs/pricing.md.txt lists Gemini 4
Argon at $2.00 / $10.00 through 2026-11-30 and Gemini 3.8 Flash at $0.75 / $3.75
through 2026-12-31 (both double afterwards). A subscription is not billed per token.
