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

const EXPIRY_SAFETY_MS = 5 * 60 * 1000;

/**
 * Absolute expiry (ms) for a token valid for `expiresInSeconds`, reduced by the
 * smaller of five minutes or 10% of its lifetime so a request never starts with
 * a token about to expire. Throws on a non-positive, non-finite, or unrepresentable lifetime.
 */
export function expiryAfter(now: number, expiresInSeconds: unknown): number {
	if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0 ||
		!Number.isFinite(now) || now < 0) {
		throw new Error("Invalid token lifetime in provider response.");
	}
	const lifetime = expiresInSeconds * 1000;
	if (!Number.isSafeInteger(Math.round(lifetime)) || now + lifetime > 8.64e15) {
		throw new Error("Invalid token lifetime in provider response.");
	}
	return now + lifetime - Math.min(EXPIRY_SAFETY_MS, lifetime / 10);
}
