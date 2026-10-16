import assert from "node:assert/strict";
import { test } from "bun:test";
import {
	anthropicIdFromName, compareCatalog, parseAnthropicPricing, parseMistralPricing, parseOpenAIPricing, OPENAI_LONG_CONTEXT_TOKENS,
	type CatalogModel, type OfficialRow,
} from "../../scripts/pricing/parse.ts";

// Synthetic page excerpts: same table shapes as the official pages, invented
// model names and prices. No network, no real captures.

const ANTHROPIC_PAGE = `
# Pricing

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Synthetic 9.1 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Old 1 ([retired, except on Somewhere](https://example.test/deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Tiny 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Tiny 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

*<sup>2 footnote text mentioning $99 / MTok must be ignored</sup>*

## Cloud platform pricing

| Claude Decoy 1 | $1 / MTok | $1 / MTok | $1 / MTok | $1 / MTok | $1 / MTok |
`;

const MISTRAL_PAGE = `
# API pricing

| Model | API name | Price |
| --- | --- | --- |
| [Synthetic Large](/models/a) | \`synthetic-large\` | Input $0.68 /M Tokens (sale price, regular $1.36)<br>Cached input $0.07 /M Tokens (sale price, regular $0.14)<br>Output $2.09 /M Tokens (sale price, regular $4.18) |
| [Synthetic Small](/models/b) | \`synthetic-small\` | Input $0.15 /M Tokens<br>Output $0.6 /M Tokens |
| [Synthetic OCR](/models/c) | \`synthetic-ocr\` | Input $4 /1000 Pages<br>Input $5 /1000 Annotated Pages |
| [Synthetic Moderation](/models/d) | \`synthetic-moderation\` | Free<br>$0 /M Tokens |
`;

// ---------------------------------------------------------------------------
// Anthropic parsing
// ---------------------------------------------------------------------------

test("anthropic ids follow the dotted-name to hyphenated-id scheme", () => {
	assert.equal(anthropicIdFromName("Claude Opus 5.5"), "claude-opus-5-5");
	assert.equal(anthropicIdFromName(" Claude Fable 5 "), "claude-fable-5");
});

test("anthropic parser reads the model table only, with all five rate columns", () => {
	const rows = parseAnthropicPricing(ANTHROPIC_PAGE);
	assert.deepEqual(rows.map((r) => r.id), ["claude-synthetic-9-1", "claude-old-1", "claude-tiny-5-5", "claude-tiny-5-5"]);
	assert.deepEqual(rows[0].rates, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 });
	assert.ok(!rows.some((r) => r.id === "claude-decoy-1"), "later sections are request-time pricing, not model rates");
});

test("anthropic parser flags retired rows and turns the long-prompt row into a tier", () => {
	const rows = parseAnthropicPricing(ANTHROPIC_PAGE);
	assert.equal(rows[1].retired, true);
	assert.equal(rows[0].retired, undefined);
	assert.equal(rows[2].inputTokensAbove, undefined, "the 'up to' row is the base rate");
	assert.equal(rows[3].inputTokensAbove, 100000);
	assert.equal(rows[3].rates.input, 0.5);
});

test("anthropic parser tolerates a missing section and malformed rows", () => {
	assert.deepEqual(parseAnthropicPricing("# nothing here"), []);
	assert.deepEqual(parseAnthropicPricing("## Model pricing\n\n| Claude Broken 1 | n/a | n/a |\n"), []);
});

// ---------------------------------------------------------------------------
// Mistral parsing
// ---------------------------------------------------------------------------

test("mistral parser keeps token-priced rows and skips pages, minutes, and unlabeled free rows", () => {
	assert.deepEqual(parseMistralPricing(MISTRAL_PAGE).map((r) => r.id), ["synthetic-large", "synthetic-small"]);
});

test("mistral sale rows carry the CURRENT rates plus the regular ones aside", () => {
	const [sale, plain] = parseMistralPricing(MISTRAL_PAGE);
	assert.deepEqual(sale.rates, { input: 0.68, output: 2.09, cacheRead: 0.07 });
	assert.deepEqual(sale.timeLimited, { regular: { input: 1.36, output: 4.18, cacheRead: 0.14 } });
	assert.deepEqual(plain.rates, { input: 0.15, output: 0.6 });
	assert.equal(plain.timeLimited, undefined);
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const cost = (input: number, output: number, cacheRead: number, cacheWrite: number, tiers?: CatalogModel["cost"]["tiers"]) =>
	({ input, output, cacheRead, cacheWrite, ...(tiers ? { tiers } : {}) });
const kinds = (catalog: CatalogModel[], rows: OfficialRow[]) =>
	Object.fromEntries(compareCatalog(catalog, rows).map((f) => [f.id, f.kind]));

const OFFICIAL = parseAnthropicPricing(ANTHROPIC_PAGE);
const TINY_TIER = [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }];

test("a catalog identical to the page matches, including tiers, dated aliases, and float noise", () => {
	const findings = compareCatalog([
		{ id: "claude-synthetic-9-1", cost: cost(4, 20, 0.2, 5) },
		{ id: "claude-synthetic-9-1-20260101", cost: cost(4, 20, 0.2, 5) },
		{ id: "claude-tiny-5-5", cost: cost(0.1 + 0.2 - 0.2, 0.5, 0.01, 0.125, TINY_TIER) },
	], OFFICIAL);
	assert.deepEqual(findings.filter((f) => f.kind !== "official-only").map((f) => f.kind), ["match", "match", "match"]);
	const alias = findings.find((f) => f.id === "claude-synthetic-9-1-20260101");
	assert.equal(alias?.kind === "match" && alias.viaAlias, "claude-synthetic-9-1");
});

test("a wrong rate is reported with both values", () => {
	const [finding] = compareCatalog([{ id: "claude-synthetic-9-1", cost: cost(4, 25, 0.2, 5) }], OFFICIAL);
	assert.equal(finding.kind, "diff");
	assert.deepEqual(finding.kind === "diff" && finding.differences, ["output: pi=25 official=20"]);
});

test("tier differences and missing tiers are reported", () => {
	const wrongTier = compareCatalog([{ id: "claude-tiny-5-5", cost: cost(0.1, 0.5, 0.01, 0.125, [{ ...TINY_TIER[0], output: 9 }]) }], OFFICIAL)[0];
	assert.ok(wrongTier.kind === "diff" && wrongTier.differences.some((d) => d.startsWith("tier>100000 output")));
	const noTier = compareCatalog([{ id: "claude-tiny-5-5", cost: cost(0.1, 0.5, 0.01, 0.125) }], OFFICIAL)[0];
	assert.ok(noTier.kind === "diff" && noTier.differences.includes("missing tier above 100000 tokens"));
});

test("an official 1h cache write that is not 2x input is flagged because Pi assumes 2x", () => {
	const rows: OfficialRow[] = [{ id: "m", rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 3 } }];
	const [finding] = compareCatalog([{ id: "m", cost: cost(1, 2, 0.1, 1.25) }], rows);
	assert.ok(finding.kind === "diff" && finding.differences[0].includes("not 2x input"));
});

test("models without an official row are unverified, never guessed by alias", () => {
	const result = kinds([
		{ id: "claude-synthetic-9-1-latest", cost: cost(4, 20, 0.2, 5) },
		{ id: "unknown-model", cost: cost(1, 1, 1, 1) },
	], OFFICIAL);
	assert.equal(result["claude-synthetic-9-1-latest"], "unverified", "only dated-snapshot suffixes resolve to a base id");
	assert.equal(result["unknown-model"], "unverified");
});

test("official rows missing from the catalog are listed, with retired ones marked", () => {
	const findings = compareCatalog([], OFFICIAL);
	assert.deepEqual(findings.map((f) => [f.id, f.kind === "official-only" && f.retired]), [
		["claude-synthetic-9-1", false], ["claude-old-1", true], ["claude-tiny-5-5", false],
	]);
});

test("a time-limited price is carried on the match so the report can warn about it", () => {
	const rows = parseMistralPricing(MISTRAL_PAGE);
	const [finding] = compareCatalog([{ id: "synthetic-large", cost: cost(0.68, 2.09, 0.07, 0) }], rows);
	assert.ok(finding.kind === "match" && finding.timeLimited?.regular.input === 1.36);
});

test("a catalog still on the regular price during a sale is a difference, not a pass", () => {
	const rows = parseMistralPricing(MISTRAL_PAGE);
	const [finding] = compareCatalog([{ id: "synthetic-large", cost: cost(1.36, 4.18, 0.14, 0) }], rows);
	assert.equal(finding.kind, "diff");
});

// ---------------------------------------------------------------------------
// OpenAI parsing
// ---------------------------------------------------------------------------

const OPENAI_PAGE = `
# Pricing

### Standard pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| synthetic-a | $2.00 | $0.10 | $2.50 | $10.00 | $4.00 | $0.20 | $5.00 | $15.00 |
| synthetic-b (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |
| synthetic-pro (<272K context length) | $30.00 | - | - | $180.00 | - | - | - | - |

### Batch pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| synthetic-a | $1.00 | $0.05 | $1.25 | $5.00 | $2.00 | $0.10 | $2.50 | $7.50 |
`;

test("openai parser reads only the standard table: short columns are the base, long columns a 272K tier", () => {
	const rows = parseOpenAIPricing(OPENAI_PAGE);
	assert.deepEqual(rows.map((r) => [r.id, r.inputTokensAbove]), [
		["synthetic-a", undefined], ["synthetic-a", OPENAI_LONG_CONTEXT_TOKENS],
		["synthetic-b", undefined], ["synthetic-b", OPENAI_LONG_CONTEXT_TOKENS], ["synthetic-pro", undefined],
	]);
	assert.deepEqual(rows[0].rates, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
	assert.deepEqual(rows[1].rates, { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 });
	assert.deepEqual(rows[2].rates, { input: 5, output: 30, cacheRead: 0.5 }, "a dash means not offered, so no cache-write rate");
	assert.ok(!rows.some((r) => r.rates.input === 1), "the batch table is a different service mode");
});

test("openai parser tolerates a missing section", () => assert.deepEqual(parseOpenAIPricing("# nothing"), []));

test("a Codex-style catalog matches including the long-context tier, and a dash does not fail a zero cache write", () => {
	const rows = parseOpenAIPricing(OPENAI_PAGE);
	const tier = [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }];
	const findings = compareCatalog([
		{ id: "synthetic-a", cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] } },
		{ id: "synthetic-b", cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, tiers: tier } },
		{ id: "synthetic-unlisted", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
	], rows);
	assert.deepEqual(findings.filter((f) => f.kind !== "official-only").map((f) => [f.id, f.kind]), [
		["synthetic-a", "match"], ["synthetic-b", "match"], ["synthetic-unlisted", "unverified"],
	]);
});
