/** Explicit quota refusals from the response headers, not guesses from utilization or error text. */
export function quotaExplanation(status: number, headers: Record<string, string>): string | undefined {
	const prefix = "anthropic-ratelimit-unified-";
	if (status !== 429 || headers[`${prefix}overage-status`] === "allowed") return undefined;
	const windows = [
		["7d", "weekly"], ["7d-sonnet", "weekly Sonnet"], ["7d-opus", "weekly Opus"], ["5h", "five-hour"], ["", "account"],
	] as const;
	const rejected = windows.filter(([key]) => headers[`${prefix}${key ? key + "-" : ""}status`] === "rejected");
	if (!rejected.length) return undefined;
	const lines = ["Claude subscription usage limit reached (HTTP 429)."];
	for (const [key, label] of rejected) {
		const raw = headers[`${prefix}${key ? key + "-" : ""}reset`];
		const seconds = raw && /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
		const reset = seconds > 0 && seconds <= 253402300799 ? new Date(seconds * 1000).toISOString() : undefined;
		lines.push(`The ${label} usage limit rejected this request.${reset ? ` Resets at ${reset} (UTC).` : " Reset time unavailable."}`);
	}
	if (headers[`${prefix}overage-disabled-reason`] === "org_level_disabled") {
		lines.push("Paid overage is disabled by your organization; ask its administrator to enable it if appropriate.");
	} else if (headers[`${prefix}overage-status`] === "rejected") {
		lines.push("Paid overage is unavailable for this request.");
	}
	lines.push("Wait for the rejected quotas to reset or use another account/provider. Retrying immediately will not restore quota.");
	return lines.join("\n");
}
