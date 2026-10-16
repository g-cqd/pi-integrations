/** Synthetic JWT builder for tests. The signature segment is a fixed dummy; no real tokens. */
export function syntheticJwt(payload: Record<string, unknown>): string {
	const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.synthetic-signature`;
}

/** An access token carrying the ChatGPT account-id claim under the OpenAI auth namespace; `null` omits the claim. */
export function codexAccessToken(accountId: string | null = "acct_synthetic_123", extra: Record<string, unknown> = {}): string {
	return syntheticJwt({ ...extra, ...(accountId === null ? {} : { "https://api.openai.com/auth": { chatgpt_account_id: accountId } }) });
}
