import type { ModelCost } from "@earendil-works/pi-ai";
import { requestText, type FetchImplementation } from "../../shared/index.ts";
import { parseCopilotPrices } from "./pricing-source.ts";
import snapshot from "./prices.json" with { type: "json" };

type Entry = ModelCost & { expires?: string };
const DAY = 24 * 60 * 60 * 1000;

export function createPricing(deps: { now?: () => number; fetchImpl?: FetchImplementation } = {}) {
 const now = deps.now ?? Date.now;
 let prices = snapshot.prices as Record<string, Entry>;
 let checkedAt = -Infinity;
 let pending: Promise<void> | undefined;
 return {
  /** GitHub Copilot USD/1M token list prices, not vendor rates or a bill. */
  price(id: string, at = now()): ModelCost | undefined {
   const entry = Object.hasOwn(prices, id) ? prices[id] : undefined;
   if (!entry || (entry.expires && at >= Date.parse(entry.expires))) return undefined;
   const { expires: _expires, ...cost } = entry;
   return { ...cost, ...(cost.tiers ? { tiers: cost.tiers.map(tier => ({ ...tier })) } : {}) };
  },
  async refresh(signal?: AbortSignal): Promise<void> {
   if (signal?.aborted) return;
   if (pending) return pending;
   if (now() - checkedAt < DAY) return;
   pending = (async () => {
    try {
     const timeout = AbortSignal.timeout(5000);
     const result = await requestText("https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml", {}, {
      fetchImpl: deps.fetchImpl, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
     });
     if (!result.response.ok) throw new Error("Official price source unavailable");
     const fresh = parseCopilotPrices(result.text).prices;
     // Replace the live table atomically; removed models must not retain stale prices.
     prices = fresh;
    } catch {
     // Pricing is advisory. Never break inference or overwrite verified data on
     // timeout, source-format changes, or a temporarily unreachable public site.
    } finally {
     if (!signal?.aborted) checkedAt = now();
    }
   })();
   try { await pending; } finally { pending = undefined; }
  },
 };
}
const pricing = createPricing();
export const copilotPrice = pricing.price;
export const refreshCopilotPrices = pricing.refresh;
