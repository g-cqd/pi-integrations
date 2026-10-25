import assert from "node:assert/strict";
import { test } from "bun:test";
import { ProtocolDriftError, driftDetailsFromCapture } from "../../src/domains/claude/diagnostics.ts";

const prefix = "anthropic-ratelimit-unified-";
function report(headers: Record<string, string>, status = 429) {
	return new ProtocolDriftError(driftDetailsFromCapture({ status, headers })!);
}

test("a rejected weekly quota explains the refusal without protocol drift advice", () => {
	const error = report({
		[`${prefix}5h-status`]: "allowed", [`${prefix}5h-utilization`]: "0.01",
		[`${prefix}7d-status`]: "rejected", [`${prefix}7d-utilization`]: "1.0",
		[`${prefix}7d-reset`]: "1793160000", [`${prefix}status`]: "rejected",
		[`${prefix}overage-status`]: "rejected", [`${prefix}overage-disabled-reason`]: "org_level_disabled",
		"request-id": "req_quota",
	});
	assert.match(error.message, /weekly usage limit/i);
	assert.match(error.message, /2026-10-28T04:00:00.000Z/);
	assert.match(error.message, /overage.*disabled.*organization/i);
	assert.match(error.message, /req_quota/);
	assert.doesNotMatch(error.message, /protocol drift|drift checklist|canonical identity|fingerprint/);
	assert.equal((error.toDiagnostic().details as Record<string, unknown>).classification, "usage_limit");
});

test("explicit quota rejection works without a body or usable reset", () => {
	for (const reset of ["NaN", "Infinity", "-1", "1e100", ""]) {
		const error = report({ [`${prefix}5h-status`]: "rejected", [`${prefix}5h-reset`]: reset });
		assert.match(error.message, /five-hour usage limit/i);
		assert.doesNotMatch(error.message, /Invalid Date|protocol drift/);
	}
});

test("allowed or absent quota signals do not turn a 429 into confirmed exhaustion", () => {
	for (const headers of ([{}, { [`${prefix}7d-utilization`]: "1.0" },
		{ [`${prefix}7d-status`]: "allowed" },
		{ [`${prefix}7d-status`]: "rejected", [`${prefix}overage-status`]: "allowed" }] as Record<string, string>[])) {
		assert.match(report(headers).message, /possible protocol drift/);
	}
	assert.doesNotMatch(report({ [`${prefix}7d-status`]: "rejected" }, 401).message, /weekly usage limit/i);
});
