/**
 * Antigravity (`agy`) subscription provider: Google sign-in only, no API-key
 * configuration. The model catalog is read live from the account (nothing is
 * guessed), and inference runs through this domain's own `cloudcode-pa` stream.
 */
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AnyModel } from "@earendil-works/pi-ai";
import { generatePKCE, validSecret, type HttpOptions } from "../../shared/index.ts";
import { fetchAvailableModels, loadCodeAssist, resolveBaseUrl, PROJECT_ID_RE, type AvailableModel } from "./cloudcode.ts";
import {
	buildAuthorizeUrl, exchangeAuthorizationCode, parseAuthorizationInput, refreshCredentials, requireClientSecret, resolveClientSecret,
	type AgyCredentials,
} from "./oauth.ts";
import { createAutomaticSecretResolver } from "./secret-resolver.ts";
import { API_ID, createAgyStreamSimple, encodeApiKey } from "./stream.ts";

export const PROVIDER_ID = "agy-subscription";
export const DISPLAY_NAME = "Antigravity Subscription (experimental)";
export const CATALOG_PLACEHOLDER = "agy-catalog-loading";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Used only when the server reports no limit; these are not verified service limits. */
const FALLBACK_CONTEXT = 128000;
const FALLBACK_MAX_OUTPUT = 8192;

interface Dependencies extends HttpOptions {
	env?: Record<string, string | undefined>;
	now?: () => number;
	clientSecret?: () => string | undefined;
	/** Override the inference stream (tests). Defaults to this domain's cloudcode stream. */
	streamSimple?: NonNullable<ProviderConfig["streamSimple"]>;
}

function randomState(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

export function toModelConfig(model: AvailableModel, baseUrl: string): ProviderModelConfig {
	return {
		id: model.id,
		name: model.preview ? `${model.displayName} (preview)` : model.displayName,
		api: API_ID, baseUrl,
		input: model.supportsImages ? ["text", "image"] : ["text"],
		reasoning: model.supportsThinking,
		cost: ZERO_COST, // a subscription is not billed per token, so cost is unknown, not free
		contextWindow: model.maxTokens ?? FALLBACK_CONTEXT,
		maxTokens: model.maxOutputTokens ?? FALLBACK_MAX_OUTPUT,
	};
}

export function createAgyProvider(deps: Dependencies = {}): ProviderConfig {
	const env = deps.env ?? process.env;
	const base = resolveBaseUrl(env);
	const now = deps.now ?? Date.now;
	const automaticSecret = createAutomaticSecretResolver({ env, fetchImpl: deps.fetchImpl });
	const oauthOptions = async (signal?: AbortSignal) => {
		const secret = deps.clientSecret ? deps.clientSecret() : resolveClientSecret(env) ?? await automaticSecret(signal);
		return { fetchImpl: deps.fetchImpl, signal, now, clientSecret: () => secret };
	};
	const streamSimple = deps.streamSimple ?? createAgyStreamSimple({ baseUrl: base, fetchImpl: deps.fetchImpl, now });

	const placeholder: ProviderModelConfig = {
		id: CATALOG_PLACEHOLDER, name: "Sign in / refresh Antigravity model catalog", api: API_ID, baseUrl: base,
		input: ["text"], reasoning: false, cost: ZERO_COST, contextWindow: FALLBACK_CONTEXT, maxTokens: FALLBACK_MAX_OUTPUT,
	};

	async function login(callbacks: OAuthLoginCallbacks) {
		callbacks.signal?.throwIfAborted();
		requireClientSecret(await oauthOptions(callbacks.signal)); // fail before opening a browser
		const { verifier, challenge } = await generatePKCE();
		callbacks.signal?.throwIfAborted();
		const state = randomState();
		callbacks.onAuth({
			url: buildAuthorizeUrl({ state, codeChallenge: challenge }),
			instructions: "Sign in with the Google account that has your Antigravity subscription, then paste the authorization code shown on the final page. Do not share it.",
		});
		const pasted = await callbacks.onPrompt({ message: "Paste the authorization code from the success page:", placeholder: "<authorization code>" });
		callbacks.signal?.throwIfAborted();
		const parsed = parseAuthorizationInput(pasted, state);
		if (!parsed) throw new Error("Invalid authorization response. Paste the authorization code (or the full redirect URL) from this sign-in, or restart /login.");
		callbacks.onProgress?.("Exchanging authorization code…");
		const credentials = await exchangeAuthorizationCode({ code: parsed.code, codeVerifier: verifier, ...await oauthOptions(callbacks.signal) });
		callbacks.onProgress?.("Looking up your Antigravity project…");
		const account = await loadCodeAssist(credentials.access, { baseUrl: base, fetchImpl: deps.fetchImpl, signal: callbacks.signal });
		return { ...credentials, projectId: account.projectId, ...(account.tierId ? { tierId: account.tierId } : {}) };
	}

	return {
		name: DISPLAY_NAME,
		baseUrl: base,
		api: API_ID,
		models: [placeholder],
		oauth: {
			name: DISPLAY_NAME,
			isSubscription: true,
			login,
			refreshToken: async (credentials, signal) => refreshCredentials(credentials as AgyCredentials, await oauthOptions(signal)),
			getApiKey: (credentials) => {
				const projectId = (credentials as AgyCredentials).projectId;
				return typeof projectId === "string" ? encodeApiKey(credentials.access, projectId) : JSON.stringify({ token: credentials.access });
			},
		},
		refreshModels: async (context) => {
			// Pi calls this twice: once with allowNetwork false to restore from the
			// store, then with network to fetch. Restoring from `stored` is what makes
			// the catalog survive restarts (Pi persists only what we publish).
			if (!context.allowNetwork) {
				const stored = (context as { stored?: { models?: unknown[] } }).stored;
				const restored = stored?.models?.filter((m): m is NonNullable<ProviderModelConfig> =>
					typeof m === "object" && m !== null && (m as { id?: unknown }).id !== CATALOG_PLACEHOLDER) ?? [];
				return restored.length > 0 ? restored : [placeholder];
			}
			const credential = context.credential as { access?: unknown; projectId?: unknown } | undefined;
			// projectId is validated with the same rule the stream applies, so a
			// malformed stored value is refused here instead of being sent to
			// Google in a request that cannot succeed.
			if (!credential || !validSecret(credential.access) ||
				typeof credential.projectId !== "string" || !PROJECT_ID_RE.test(credential.projectId)) return [placeholder];
			const { models, defaultModelId } = await fetchAvailableModels(credential.access, {
				baseUrl: base, projectId: credential.projectId, fetchImpl: deps.fetchImpl, signal: context.signal,
			});
			if (models.length === 0) return [placeholder];
			const ordered = [...models].sort((a, b) => Number(b.id === defaultModelId) - Number(a.id === defaultModelId));
			// provider is stamped here because the persisted entry bypasses the
			// composer's in-memory stamping; restore filters on it.
			const listed = ordered.map((model) => ({ ...toModelConfig(model, base), provider: PROVIDER_ID })) as unknown as ProviderModelConfig[];
			// Persist so the catalog survives restarts; Pi writes only what we
			// publish, and `update` is the composer's job (it applies our return).
			await context.publish({ persist: { models: listed as unknown as AnyModel[], checkedAt: now() } });
			return listed;
		},
		streamSimple: (model, context, options) => {
			if (model.id === CATALOG_PLACEHOLDER) throw new Error("Antigravity catalog not loaded; sign in and refresh models.");
			return streamSimple(model, context, options);
		},
	};
}
