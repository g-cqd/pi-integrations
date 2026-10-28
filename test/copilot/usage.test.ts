import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseQuotaHeaders, formatQuota } from "../../src/domains/copilot/usage.ts";

test("quota headers preserve units, fractional consumption, overage and reset", () => {
 const q = parseQuotaHeaders(new Headers({ "x-quota-snapshot-premium_models": "ent=1000&rem=72.5&ov=2.5&ovPerm=true&rst=2026-11-01" }), 123)!;
 assert.deepEqual(q, { kind: "premium_models", entitlement: 1000, remaining: 725, used: 275, percentRemaining: 72.5, unlimited: false, overage: 2.5, overageEnabled: true, reset: "2026-11-01", fetchedAt: 123 });
 assert.deepEqual(formatQuota(q), { text: "Copilot [##--------] ~275/1000 used · ~725 left · overage 2.5 enabled", color: "success" });
});

test("legacy requests and free chat quotas are not mislabeled as AI credits", () => {
 for (const [kind, unit] of [["premium_interactions", "requests"], ["chat", "chat"]]) {
  const q = parseQuotaHeaders(new Headers({ [`x-quota-snapshot-${kind}`]: "ent=300&rem=10&ov=0&ovPerm=false" }), 0)!;
  const f = formatQuota(q);
  assert.ok(f.text.includes(unit)); assert.equal(f.color, "error"); assert.ok(f.text.includes("~270/300"));
 }
});

test("unknown, malformed and contradictory quotas never become a zero balance", () => {
 for (const value of ["", "ent=100", "ent=abc&rem=50", "ent=100&rem=NaN", "ent=100&rem=-1", "ent=100&rem=101", "ent=-2&rem=50", "ent=100&rem=50&ov=-1", "ent=100&rem=50&ovPerm=oops", "ent=100&rem=50&rst=secret"])
  assert.equal(parseQuotaHeaders(new Headers({ "x-quota-snapshot-premium_models": value }), 0), undefined, value);
 assert.deepEqual(formatQuota(undefined), { text: "Copilot usage unavailable", color: "dim" });
});

test("unlimited, exhausted and warning quota states use distinct safe displays", () => {
 const q = (ent: number, rem: number) => parseQuotaHeaders(new Headers({ "x-quota-snapshot-premium_models": `ent=${ent}&rem=${rem}` }), 0)!;
 assert.deepEqual(formatQuota(q(-1, 100)), { text: "Copilot unlimited", color: "success" });
 assert.equal(formatQuota(q(100, 20)).color, "warning");
 assert.equal(formatQuota(q(100, 0)).text, "Copilot [##########] ~100/100 used · ~0 left");
});

test("quota color thresholds are inclusive and bar fill is bounded at both ends", () => {
 for (const [remaining, color, bar] of [[100, "success", "----------"], [25, "warning", "#######---"], [10, "error", "#########-"], [0, "error", "##########"]] as const) {
  const q = parseQuotaHeaders(new Headers({ "x-quota-snapshot-premium_models": `ent=100&rem=${remaining}` }), 0)!;
  const display = formatQuota(q);
  assert.equal(display.color, color); assert.ok(display.text.includes(`[${bar}]`));
 }
});
