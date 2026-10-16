/**
 * Pure parsers and comparison for official per-token price pages.
 *
 * Development tooling only (not shipped in the package `files`). Nothing here
 * touches the network; scripts/verify-pricing.ts does the fetching, so these
 * functions are fully testable offline with synthetic page excerpts.
 *
 * Units: every rate is USD per million tokens, the unit Pi's model `cost`
 * uses, so values compare directly with no conversion.
 */

export interface OfficialRates {
	input: number;
	output: number;
	/** Cached-input read rate, when the page lists one. */
	cacheRead?: number;
	/** 5-minute cache write rate, when the page lists one. */
	cacheWrite?: number;
	/** 1-hour cache write rate, when the page lists one. */
	cacheWrite1h?: number;
}

export interface OfficialRow {
	/** Stable id used by the API (Anthropic: derived from the display name). */
	id: string;
	rates: OfficialRates;
	/** Present when this row only applies above a prompt-size threshold. */
	inputTokensAbove?: number;
	/** The page marks this row retired; it is not expected in Pi's catalog. */
	retired?: boolean;
	/** A time-limited price is in effect; `regular` holds the post-promotion rates. */
	timeLimited?: { regular: Partial<OfficialRates> };
}

const dollars = (cell: string | undefined): number | undefined => {
	const match = /\$([0-9]+(?:\.[0-9]+)?)/.exec(cell ?? "");
	return match ? Number(match[1]) : undefined;
};

function section(markdown: string, heading: string): string {
	const start = markdown.indexOf(heading);
	if (start < 0) return "";
	const rest = markdown.slice(start + heading.length);
	const end = rest.search(/\n## /);
	return end < 0 ? rest : rest.slice(0, end);
}

/** "Claude Opus 5.5" -> "claude-opus-5-5" (the API id scheme for current models). */
export function anthropicIdFromName(name: string): string {
	return name.trim().toLowerCase().replace(/\./g, "-").replace(/\s+/g, "-");
}

/**
 * Parse Anthropic's "Model pricing" table. Columns are: model, base input,
 * 5m cache write, 1h cache write, cache hits, output. The long-prompt Haiku
 * row becomes a tier row. Everything outside that section (batch, fast mode,
 * data residency, tools) is request-time pricing, not a per-model rate.
 */
export function parseAnthropicPricing(markdown: string): OfficialRow[] {
	const rows: OfficialRow[] = [];
	for (const line of section(markdown, "## Model pricing").split("\n")) {
		const cells = line.split("|").map((c) => c.trim());
		if (cells.length < 7 || !/^Claude /.test(cells[1] ?? "")) continue;
		const [input, write5m, write1h, read, output] = [2, 3, 4, 5, 6].map((i) => dollars(cells[i]));
		if (input === undefined || output === undefined) continue;
		const label = cells[1];
		const over = /prompts over ([0-9][0-9,]*) tokens/.exec(label);
		const name = label.replace(/\s*\(.*$/, "").replace(/\s*\[.*$/, "");
		rows.push({
			id: anthropicIdFromName(name),
			rates: {
				input, output,
				...(read !== undefined ? { cacheRead: read } : {}),
				...(write5m !== undefined ? { cacheWrite: write5m } : {}),
				...(write1h !== undefined ? { cacheWrite1h: write1h } : {}),
			},
			...(over ? { inputTokensAbove: Number(over[1].replace(/,/g, "")) } : {}),
			...(/retired/i.test(label) ? { retired: true } : {}),
		});
	}
	return rows;
}

/**
 * Parse Mistral's API pricing page. Each row is | model | `api-name` | price |
 * where the price cell holds "Input $x /M Tokens<br>Cached input ...<br>Output ...".
 * Only token-priced rows are kept (pages, minutes, and characters are skipped).
 * A "(sale price, regular $y)" annotation marks a time-limited price: the row
 * carries the CURRENT rates (what is billed now) and the regular ones aside.
 */
export function parseMistralPricing(markdown: string): OfficialRow[] {
	const rows: OfficialRow[] = [];
	for (const line of markdown.split("\n")) {
		const cells = line.split("|").map((c) => c.trim());
		const id = /`([^`]+)`/.exec(cells[2] ?? "")?.[1];
		if (!id || cells.length < 4) continue;
		const now: Partial<OfficialRates> = {};
		const regular: Partial<OfficialRates> = {};
		let sale = false;
		for (const part of (cells[3] ?? "").split("<br>")) {
			const m = /^(Input|Cached input|Output) \$([0-9.]+) \/M Tokens(?: \(sale price, regular \$([0-9.]+)\))?/.exec(part.trim());
			if (!m) continue;
			const key = m[1] === "Input" ? "input" : m[1] === "Output" ? "output" : "cacheRead";
			now[key] = Number(m[2]);
			if (m[3] !== undefined) { regular[key] = Number(m[3]); sale = true; }
		}
		if (now.input === undefined || now.output === undefined) continue;
		rows.push({
			id,
			rates: { input: now.input, output: now.output, ...(now.cacheRead !== undefined ? { cacheRead: now.cacheRead } : {}) },
			...(sale ? { timeLimited: { regular } } : {}),
		});
	}
	return rows;
}

/** OpenAI's long-context pricing starts above this many prompt tokens (the page labels it "272K"). */
export const OPENAI_LONG_CONTEXT_TOKENS = 272_000;

/**
 * Parse OpenAI's "Standard pricing data" table. Columns: model, then short-context
 * input / cached input / cache writes / output, then the same four for long context.
 * A "-" means not offered. Short columns are the base rate; long columns become a
 * tier above OPENAI_LONG_CONTEXT_TOKENS. Batch, flex, fast, and other tables are
 * different service modes and are ignored.
 */
export function parseOpenAIPricing(markdown: string): OfficialRow[] {
	const start = markdown.indexOf("### Standard pricing data");
	if (start < 0) return [];
	const rest = markdown.slice(start + "### Standard pricing data".length);
	const end = rest.search(/\n### /);
	const rows: OfficialRow[] = [];
	for (const line of (end < 0 ? rest : rest.slice(0, end)).split("\n")) {
		const cells = line.split("|").map((c) => c.trim());
		if (cells.length < 11 || !/^[a-z][a-z0-9.-]*( \(.*\))?$/.test(cells[1] ?? "") || /^model$/i.test(cells[1])) continue;
		const id = cells[1].replace(/\s*\(.*$/, "");
		const rates = (offset: number): OfficialRates | undefined => {
			const [input, cached, write, output] = [0, 1, 2, 3].map((i) => dollars(cells[offset + i]));
			if (input === undefined || output === undefined) return undefined;
			return { input, output, ...(cached !== undefined ? { cacheRead: cached } : {}), ...(write !== undefined ? { cacheWrite: write } : {}) };
		};
		const short = rates(2), long = rates(6);
		if (!short) continue;
		rows.push({ id, rates: short });
		if (long) rows.push({ id, rates: long, inputTokensAbove: OPENAI_LONG_CONTEXT_TOKENS });
	}
	return rows;
}

/** The slice of Pi's model cost that is compared. Mirrors Pi's `cost` shape. */
export interface CatalogCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
}
export interface CatalogModel { id: string; cost: CatalogCost }

export type Finding =
	| { kind: "match"; id: string; viaAlias?: string; timeLimited?: OfficialRow["timeLimited"] }
	| { kind: "diff"; id: string; differences: string[] }
	| { kind: "unverified"; id: string }
	| { kind: "official-only"; id: string; retired: boolean };

const EPSILON = 1e-9;
const same = (a: number, b: number) => Math.abs(a - b) <= EPSILON;
/** Dated snapshot ids (claude-haiku-4-5-20251001) share the base model's price. */
const baseId = (id: string) => id.replace(/-\d{8}$/, "");

function compareRates(label: string, catalog: Pick<CatalogCost, "input" | "output" | "cacheRead" | "cacheWrite">, official: OfficialRates): string[] {
	const out: string[] = [];
	const check = (name: string, pi: number, ref: number | undefined) => {
		if (ref !== undefined && !same(pi, ref)) out.push(`${label}${name}: pi=${pi} official=${ref}`);
	};
	check("input", catalog.input, official.input);
	check("output", catalog.output, official.output);
	check("cacheRead", catalog.cacheRead, official.cacheRead);
	check("cacheWrite", catalog.cacheWrite, official.cacheWrite);
	return out;
}

/**
 * Compare a catalog against official rows. Pi derives 1-hour cache writes as
 * 2x input, so that relationship is verified against the page's own 1h column.
 * Catalog models with no official row are reported as unverified rather than
 * guessed by alias (only dated-snapshot suffixes are resolved).
 */
export function compareCatalog(catalog: CatalogModel[], official: OfficialRow[]): Finding[] {
	const base = official.filter((r) => r.inputTokensAbove === undefined);
	const tiers = official.filter((r) => r.inputTokensAbove !== undefined);
	const findings: Finding[] = [];
	const seen = new Set<string>();
	for (const model of catalog) {
		const row = base.find((r) => r.id === model.id) ?? base.find((r) => r.id === baseId(model.id));
		if (!row) { findings.push({ kind: "unverified", id: model.id }); continue; }
		seen.add(row.id);
		const differences = compareRates("", model.cost, row.rates);
		if (row.rates.cacheWrite1h !== undefined && !same(row.rates.cacheWrite1h, row.rates.input * 2)) {
			differences.push(`1h cache write is ${row.rates.cacheWrite1h}, not 2x input (${row.rates.input * 2}); Pi assumes 2x`);
		}
		for (const tier of tiers.filter((t) => t.id === row.id)) {
			const piTier = model.cost.tiers?.find((t) => t.inputTokensAbove === tier.inputTokensAbove);
			if (!piTier) differences.push(`missing tier above ${tier.inputTokensAbove} tokens`);
			else differences.push(...compareRates(`tier>${tier.inputTokensAbove} `, piTier, tier.rates));
		}
		findings.push(differences.length
			? { kind: "diff", id: model.id, differences }
			: { kind: "match", id: model.id, ...(model.id !== row.id ? { viaAlias: row.id } : {}), ...(row.timeLimited ? { timeLimited: row.timeLimited } : {}) });
	}
	for (const row of base) {
		if (!seen.has(row.id)) findings.push({ kind: "official-only", id: row.id, retired: row.retired === true });
	}
	return findings;
}
