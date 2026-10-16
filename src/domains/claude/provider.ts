/**
 * UI-neutral OAuth provider configuration. No request rewriting or header overrides.
 * The stable provider ID preserves Pi's existing credential namespace.
 */
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	buildAuthorizeUrl,
	exchangeAuthorizationCode,
	generatePKCE,
	parseAuthorizationCode,
	refreshCredentials,
	type FetchImplementation,
} from "./oauth.ts";

export const PROVIDER_ID = "claude-subscription";
export const DISPLAY_NAME = "Claude OAuth (experimental)";

interface Dependencies {
	models: NonNullable<ProviderConfig["models"]>;
	streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
	fetchImpl?: FetchImplementation;
	env?: Record<string, string | undefined>;
}

export function createProviderConfig(deps: Dependencies): ProviderConfig {
	const env = deps.env ?? process.env;

	async function login(callbacks: OAuthLoginCallbacks) {
		callbacks.signal?.throwIfAborted();
		const { verifier, challenge } = await generatePKCE();
		callbacks.signal?.throwIfAborted();
		const state = Array.from(crypto.getRandomValues(new Uint8Array(32)),
			(b) => b.toString(16).padStart(2, "0")).join("");
		callbacks.onAuth({
			url: buildAuthorizeUrl({
				state,
				codeChallenge: challenge,
				orgUUID: env.CLAUDE_SUBSCRIPTION_ORG_UUID?.trim() || undefined,
				loginHint: env.CLAUDE_SUBSCRIPTION_LOGIN_HINT?.trim() || undefined,
			}),
			instructions: "Sign in, then paste the full code#state from this sign-in. Do not share it.",
		});
		const pasted = await callbacks.onPrompt({
			message: "Paste the full code#state from the success page:",
			placeholder: "<code>#<state>",
		});
		callbacks.signal?.throwIfAborted();
		const parsed = parseAuthorizationCode(pasted, state);
		if (!parsed) {
			throw new Error("Invalid authorization response or missing/mismatched state. Paste the full code#state from this sign-in, or restart /login.");
		}
		callbacks.onProgress?.("Exchanging authorization code…");
		return exchangeAuthorizationCode({
			code: parsed.code,
			codeVerifier: verifier,
			state,
			fetchImpl: deps.fetchImpl,
			signal: callbacks.signal,
		});
	}

	return {
		name: DISPLAY_NAME,
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages",
		apiKey: "$CLAUDE_SUBSCRIPTION_ACCESS_TOKEN",
		oauth: {
			name: DISPLAY_NAME,
			isSubscription: true,
			login,
			refreshToken: (credentials, signal) =>
				refreshCredentials(credentials, { fetchImpl: deps.fetchImpl, signal }),
			getApiKey: (credentials) => credentials.access,
		},
		streamSimple: deps.streamSimple,
		models: deps.models,
	};
}
