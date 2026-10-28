/** Refresh/verify the pinned official Copilot price snapshot; never contacts model APIs. */
import { resolve } from "node:path";

import { PRICING_SOURCE, parseCopilotPrices } from "../src/domains/copilot/pricing-source.ts";
if (import.meta.main) {
 const response = await fetch(PRICING_SOURCE, { redirect: "error", signal: AbortSignal.timeout(30000) });
 if (!response.ok) throw new Error(`Official Copilot pricing HTTP ${response.status}`);
 const generated = JSON.stringify(parseCopilotPrices(await response.text()), null, 2) + "\n";
 const path = resolve(import.meta.dir, "../src/domains/copilot/prices.json");
 if (process.argv.includes("--write")) { await Bun.write(path, generated); console.log("Updated pinned Copilot prices."); }
 else {
  if (await Bun.file(path).text() !== generated) throw new Error("Copilot price snapshot differs; review source and regenerate with --write.");
  console.log("Copilot prices match the pinned official GitHub table (including long-context tiers).");
 }
}
