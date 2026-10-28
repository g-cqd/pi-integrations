/**
 * Browser sign-in protocol observed in Mistral's public Vibe source.
 * PKCE process -> browser approval -> poll -> API-key exchange, not OAuth refresh.
 */
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { generatePKCE } from "../../shared/pkce.ts";
import {
	apiKeyCredentials, trustedUrl, HttpStatusError, record, requestJson, validSecret, waitFor, pollUntil, type HttpOptions,
} from "../../shared/index.ts";

export const PROVIDER_ID = "mistral-vibe";

/**
 * The whole of Pi's Mistral catalog, which is what this domain offers. Every entry is declared for
 * the conversations API, and the sign-in key is not scoped to one model: a Vibe-issued key answered
 * `zai-glm-5-3` on `/v1/chat/completions` (probed 2026-10-27), so narrowing the list to a single
 * model hid models the key can actually run. Throws on an empty catalog rather than registering a
 * provider with no models.
 */
export function selectMistralCatalog<T extends { id: string }>(models: readonly T[]): T[] {
	if (models.length === 0) {
		throw new Error("Pi's Mistral catalog is empty; update Pi or this domain.");
	}
	return [...models];
}
const CONSOLE = "https://console.mistral.ai";
const AUTH_API = CONSOLE + "/api";

interface Dependencies extends HttpOptions {
	models: NonNullable<ProviderConfig["models"]>;
	streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
	now?: () => number;
	sleep?: typeof waitFor;
}

export function createMistralVibeProvider(deps: Dependencies): ProviderConfig {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? waitFor;
	const json = (url: string, init: RequestInit, signal?: AbortSignal) =>
		requestJson(url, init, { fetchImpl: deps.fetchImpl, signal });
	return {
		name: "Mistral Vibe (experimental)",
		baseUrl: "https://api.mistral.ai",
		api: "mistral-conversations",
		models: deps.models,
		streamSimple: deps.streamSimple,
		oauth: {
			// Pi uses its OAuth UI/storage compatibility layer for this browser flow.
			// The service returns an API key, not OAuth access/refresh tokens.
			name: "Mistral Vibe (experimental)",
			login: async (callbacks) => {
				callbacks.signal?.throwIfAborted();
				const { verifier, challenge } = await generatePKCE();
				callbacks.signal?.throwIfAborted();
				const total = AbortSignal.timeout(10 * 60 * 1000);
				const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, total]) : total;
				const startTime = now();
				const started = record(await json(AUTH_API + "/vibe/sign-in", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }),
				}, signal));
				if (typeof started.process_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(started.process_id)) throw new Error("Invalid Vibe sign-in process.");
				const signInUrl = trustedUrl(started.sign_in_url, CONSOLE);
				const pollUrl = trustedUrl(started.poll_url, AUTH_API);
				const expiry = typeof started.expires_at === "string" ? Date.parse(started.expires_at) : NaN;
				if (!Number.isFinite(expiry) || expiry <= now()) throw new Error("Invalid or expired Vibe sign-in process.");
				const deadline = Math.min(expiry, startTime + 10 * 60 * 1000);
				callbacks.onAuth({ url: signInUrl, instructions: "Sign in to Mistral in your browser. Pi will poll and exchange the approved process for an API key." });
				const exchangeToken = await pollUntil<string>({
					deadline, intervalMs: 3000, signal, now, sleep,
					onPending: () => callbacks.onProgress?.("Waiting for Mistral browser sign-in…"),
					poll: async () => {
						let raw: unknown;
						try { raw = await json(pollUrl, {}, signal); }
						catch (error) {
							if (error instanceof HttpStatusError && error.status === 410) throw new Error("Vibe browser sign-in expired; restart /login.");
							throw error;
						}
						const polled = record(raw);
						if (polled.status === "completed") {
							if (!validSecret(polled.exchange_token)) throw new Error("Vibe sign-in returned no valid exchange token.");
							return { state: "complete", value: polled.exchange_token };
						}
						if (polled.status === "denied") throw new Error("Vibe browser sign-in was denied.");
						if (polled.status === "expired") throw new Error("Vibe browser sign-in expired.");
						if (polled.status !== "pending") throw new Error("Vibe browser sign-in failed or returned an unknown state.");
						return { state: "pending" };
					},
				});
				signal.throwIfAborted();
				const exchanged = record(await json(AUTH_API + "/vibe/sign-in/" + encodeURIComponent(started.process_id) + "/exchange", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: verifier }),
				}, signal));
				if (!validSecret(exchanged.api_key)) throw new Error("Vibe exchange returned no valid API key.");
				return apiKeyCredentials(exchanged.api_key, now());
			},
			refreshToken: async (credentials, signal) => { signal?.throwIfAborted(); return credentials; },
			getApiKey: (credentials) => credentials.access,
		},
	};
}
