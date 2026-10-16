export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider response.");
	return value as Record<string, unknown>;
}

export function validSecret(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(value);
}

/** Pi bookkeeping only, not a provider-issued API-key expiry or refresh token. */
export function apiKeyCredentials(key: string, now: number) {
	if (!validSecret(key) || !Number.isFinite(now) || now < 0 || now > 8e15) throw new Error("Invalid API-key credential.");
	return { access: key, refresh: "", expires: now + 10 * 365 * 24 * 60 * 60 * 1000 };
}
