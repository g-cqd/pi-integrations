/** In-memory discovery; never executes the binary or persists recovered values. */
import { extractBinaryCandidates } from "./client-secret.ts";
import { CLIENT_ID, TOKEN_URL, REDIRECT_URI } from "./oauth.ts";
import { requestText, type HttpOptions } from "../../shared/index.ts";

export function createAutomaticSecretResolver(options: HttpOptions & {
	env: Record<string, string | undefined>;
	candidates?: () => string[];
}) {
	let cached: string | undefined;
	return async (signal?: AbortSignal): Promise<string | undefined> => {
		signal?.throwIfAborted();
		if (cached) return cached;
		const candidates = (options.candidates ?? (() => extractBinaryCandidates(options.env)))();
		// Bound requests even if an unexpected binary contains many matching strings.
		for (const candidate of candidates.slice(0, 128)) {
			signal?.throwIfAborted();
			const { response, text } = await requestText(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: candidate,
					grant_type: "authorization_code", code: "not-a-real-code", redirect_uri: REDIRECT_URI }).toString(),
			}, { fetchImpl: options.fetchImpl, signal });
			let error: unknown;
			try { error = JSON.parse(text)?.error; } catch { /* inconclusive */ }
			if (response.status === 400 && error === "invalid_grant") {
				cached = candidate;
				return cached;
			}
			// The ERROR CODE is the signal, not the status: Google answers
			// invalid_client with HTTP 401 (verified live) and invalid_grant with
			// 400. Checking the status for the rejection path made the very first
			// wrongly-sliced candidate abort discovery instead of advancing.
			if (error !== "invalid_client") {
				throw new Error("Antigravity client-secret discovery could not verify the installed binary. Try again later or configure AGY_OAUTH_CLIENT_SECRET.");
			}
		}
		return undefined;
	};
}
