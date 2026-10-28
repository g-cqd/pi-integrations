/** Pinned source for the offline fallback; runtime refresh uses the same official main table. */
export const PRICING_REVISION = "9568e964d18d76267faf57050dc662c450a13214";
export const PRICING_SOURCE = `https://raw.githubusercontent.com/github/docs/${PRICING_REVISION}/data/tables/copilot/models-and-pricing.yml`;
export function parseCopilotPrices(yaml: string) {
 // Deliberately accepts only the flat scalar subset used by GitHub's table.
 // Reject new YAML structures rather than guessing at changed billing semantics.
 const rows: Array<Record<string, string>> = [];
 for (const line of yaml.split(/\r?\n/)) {
  if (!line.trim() || line.trimStart().startsWith("#")) continue;
  const match = /^(- |  )([a-z_]+): (.+)$/.exec(line);
  if (!match) throw new Error("Unsupported official pricing format");
  if (match[1] === "- ") rows.push({});
  const row = rows.at(-1);
  if (!row || match[2] in row) throw new Error("Invalid official pricing row");
  let value = match[3];
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
  row[match[2]] = value;
 }
 if (!rows.length) throw new Error("Empty official pricing table");
 const prices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>; expires?: string }> = {};
 const money = (s: string | undefined) => {
  if (s === "Not applicable") return 0;
  if (s === undefined) throw new Error("Missing official price cell");
  if (!/^\$\d+(\.\d+)?$/.test(s)) throw new Error("Invalid official price cell");
  const value = Number(s.slice(1));
  if (!Number.isFinite(value)) throw new Error("Invalid official numeric price");
  return value;
 };
 for (const row of rows) {
  if (!row.model || !row.provider) throw new Error("Missing official model identity");
  // The preview fast-mode entry is a mode, not a separate unambiguous model ID.
  if (row.model.includes("(fast mode)")) continue;
  const name = row.model.replace(/\[\^.*?\]/g, "");
  const id = name.toLowerCase().replace(/ /g, "-").replace(row.provider === "anthropic" ? /\./g : /$^/, "-");
  const rates = { input: money(row.input), output: money(row.output), cacheRead: money(row.cached_input), cacheWrite: row.cache_write === undefined && !["openai", "anthropic"].includes(row.provider) ? 0 : money(row.cache_write) };
  if (row.tier === "Long context") {
   const threshold = /^> (\d+)K$/.exec(row.threshold);
   if (!threshold || !prices[id]) throw new Error("Invalid official price tier");
   (prices[id].tiers ??= []).push({ inputTokensAbove: Number(threshold[1]) * 1000, ...rates });
  } else {
   if (prices[id]) throw new Error("Duplicate default Copilot price");
   prices[id] = rates;
  }
  if (id === "gemini-4-argon" && row.model.includes("[^gemini-4-argon-promo]")) prices[id].expires = "2026-12-01T00:00:00Z";
  if (id === "gemini-3.8-flash" && row.model.includes("[^gemini-flash-promo]")) prices[id].expires = "2027-01-01T00:00:00Z";
 }
 return { source: PRICING_SOURCE, revision: PRICING_REVISION, prices };
}
