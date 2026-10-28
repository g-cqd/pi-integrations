import assert from "node:assert/strict";
import { test } from "bun:test";
import { createPricing } from "../../src/domains/copilot/pricing.ts";

const yaml = `- model: GPT-5.6 Luna
  provider: openai
  tier: Default
  input: $0.30
  output: $1.40
  cached_input: $0.03
  cache_write: $0.35
`;
test("official price refresh is credential-free, cached, and failure retains last verified prices", async () => {
 let now = 0, calls = 0;
 const pricing = createPricing({ now: () => now, fetchImpl: async (url, init) => {
  calls++; assert.equal(String(url), "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml");
  assert.equal(new Headers(init?.headers).has("authorization"), false); assert.equal(init?.redirect, "error");
  if (calls > 1) throw new Error("synthetic-network-error");
  return new Response(yaml);
 } });
 assert.equal(pricing.price("gpt-5.6-luna")?.input, .2);
 await Promise.all([pricing.refresh(), pricing.refresh()]);
 assert.equal(calls, 1); assert.equal(pricing.price("gpt-5.6-luna")?.input, .3);
 await pricing.refresh(); assert.equal(calls, 1);
 now += 24 * 60 * 60 * 1000;
 await pricing.refresh(); assert.equal(calls, 2); assert.equal(pricing.price("gpt-5.6-luna")?.input, .3);
 await pricing.refresh(); assert.equal(calls, 2);
});

test("malformed official rows never partially replace known prices", async () => {
 for (const text of ["not yaml", yaml.replace("$0.30", "secret"), yaml + yaml, yaml.replace("  output: $1.40\n", "")]) {
  const p = createPricing({ fetchImpl: async () => new Response(text) });
  await p.refresh(); assert.equal(p.price("gpt-5.6-luna")?.input, .2);
 }
});

test("cancellation does not erase prices or prevent later refresh", async () => {
 const p = createPricing({ fetchImpl: async () => new Response(yaml) });
 const c = new AbortController(); c.abort(); await p.refresh(c.signal);
 assert.equal(p.price("gpt-5.6-luna")?.input, .2);
 await p.refresh(); assert.equal(p.price("gpt-5.6-luna")?.input, .3);
});
