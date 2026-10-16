/**
 * Verify the per-token prices this package inherits from Pi's bundled model
 * catalogs against the vendors' official price pages.
 *
 *   bun run verify:pricing            report; exit 1 only on a price DIFFERENCE
 *   bun run verify:pricing --strict   also exit 1 on unverified or time-limited rows
 *
 * Needs network access, so it is deliberately NOT part of `bun test`.
 * Covered: Claude (Anthropic catalog), Mistral/Vibe (Mistral catalog), and Codex
 * (Pi's openai-codex catalog). Antigravity has no static catalog: its models and
 * limits come from the account at runtime and its price per token is unknown.
 * Prices are list-price API rates in USD per million tokens. Subscription
 * sign-ins are not billed per token; these numbers are estimates, not charges.
 */
import { getModels } from "@earendil-works/pi-ai/compat";
import {
	compareCatalog, parseAnthropicPricing, parseMistralPricing, parseOpenAIPricing,
	type CatalogModel, type Finding, type OfficialRow,
} from "./pricing/parse.ts";

const SOURCES = [
	{ provider: "anthropic", label: "Claude", url: "https://platform.claude.com/docs/en/about-claude/pricing.md", parse: parseAnthropicPricing },
	{ provider: "mistral", label: "Mistral/Vibe", url: "https://docs.mistral.ai/inference/pricing.md", parse: parseMistralPricing },
	{ provider: "openai-codex", label: "Codex", url: "https://developers.openai.com/api/docs/pricing.md", parse: parseOpenAIPricing },
] as const;

const strict = process.argv.includes("--strict");

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
	if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
	return response.text();
}

function describe(finding: Finding): string {
	switch (finding.kind) {
		case "match": {
			const notes = [
				finding.viaAlias ? `dated alias of ${finding.viaAlias}` : "",
				finding.timeLimited ? `TIME-LIMITED price; regular ${JSON.stringify(finding.timeLimited.regular)}` : "",
			].filter(Boolean).join("; ");
			return `OK          ${finding.id}${notes ? `  (${notes})` : ""}`;
		}
		case "diff": return `DIFF        ${finding.id}: ${finding.differences.join("; ")}`;
		case "unverified": return `UNVERIFIED  ${finding.id}: no row on the official page`;
		case "official-only": return `not in Pi  ${finding.id}${finding.retired ? " (retired)" : ""}`;
	}
}

let diffs = 0, unverified = 0, timeLimited = 0;
console.log(`Pricing verification, ${new Date().toISOString().slice(0, 10)}. USD per million tokens, list-price API rates.\n`);
for (const source of SOURCES) {
	let rows: OfficialRow[];
	try { rows = source.parse(await fetchText(source.url)); }
	catch (error) {
		console.log(`${source.label}: could not fetch ${source.url} (${error instanceof Error ? error.message : String(error)})\n`);
		diffs++; // an unreachable source is not a pass
		continue;
	}
	const catalog = getModels(source.provider) as unknown as CatalogModel[];
	const findings = compareCatalog(catalog, rows);
	console.log(`${source.label}  ${source.url}  (${rows.length} official rows, ${catalog.length} catalog models)`);
	for (const finding of findings) console.log("  " + describe(finding));
	const count = (kind: Finding["kind"]) => findings.filter((f) => f.kind === kind).length;
	diffs += count("diff");
	unverified += count("unverified");
	timeLimited += findings.filter((f) => f.kind === "match" && f.timeLimited).length;
	console.log(`  => ${count("match")} match, ${count("diff")} differ, ${count("unverified")} unverified, ${count("official-only")} official-only\n`);
}
if (diffs) console.log(`FAIL: ${diffs} price difference(s) or unreachable source(s).`);
else console.log(`PASS: no price differences.${unverified ? ` ${unverified} model(s) unverified.` : ""}${timeLimited ? ` ${timeLimited} time-limited price(s) in effect.` : ""}`);
process.exit(diffs > 0 || (strict && (unverified > 0 || timeLimited > 0)) ? 1 : 0);
