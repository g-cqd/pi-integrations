import assert from "node:assert/strict";
import { test } from "bun:test";
import { copilotPrice } from "../../src/domains/copilot/pricing.ts";

test("Copilot pricing uses explicit GitHub rates and long-context thresholds", () => {
 assert.deepEqual(copilotPrice("gpt-5.6-luna"), { input: .2, output: 1.2, cacheRead: .02, cacheWrite: .25, tiers: [{ inputTokensAbove: 200000, input: .4, output: 1.8, cacheRead: .04, cacheWrite: .5 }] });
 assert.deepEqual(copilotPrice("claude-sonnet-5-5"), { input: 2, output: 10, cacheRead: .1, cacheWrite: 2.5 });
 assert.deepEqual(copilotPrice("mai-code-1.1-flash"), { input: .2, output: 1.2, cacheRead: .02, cacheWrite: 0 });
});

test("unknown IDs are never guessed from a model family", () => {
 for (const id of ["toString", "__proto__", "synthetic-model", "claude-sonnet-5-5-new", "gpt-6-auto", "gpt-5.6-luna-20990101"]) assert.equal(copilotPrice(id), undefined);
});

test("promotional prices stop applying when their published offer expires", () => {
 assert.equal(copilotPrice("gemini-4-argon", Date.parse("2026-11-30T23:59:59Z"))?.input, 2);
 assert.equal(copilotPrice("gemini-4-argon", Date.parse("2026-12-01T00:00:00Z")), undefined);
 assert.equal(copilotPrice("gemini-3.8-flash", Date.parse("2027-01-01T00:00:00Z")), undefined);
});

 test("catalog applies Copilot prices rather than zero cost for known IDs", async () => {
  const { parseCatalog } = await import("../../src/domains/copilot/catalog.ts");
  const models = parseCatalog({ data: [{ id: "claude-sonnet-5-5", model_picker_enabled: true, capabilities: { type: "chat", supports: { tool_calls: true, streaming: true } } }] }, "https://api.githubcopilot.com");
  assert.deepEqual(models[0].cost, { input: 2, output: 10, cacheRead: .1, cacheWrite: 2.5 });
 });
