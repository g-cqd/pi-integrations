/**
 * Codex subscription provider: sign-in only, no API-key configuration.
 * Inference is delegated to Pi's `openai-codex-responses` implementation, which
 * reads the ChatGPT account id from the access token it is given.
 */
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	awaitAuthorizationInput, generatePKCE, pollUntil, startLoopback, waitFor,
	type HttpOptions, type LoopbackOptions, type LoopbackServer,
} from "../../shared/index.ts";
import {
	buildAuthorizeUrl, CALLBACK_PATH, CALLBACK_PORT, DEVICE_CODE_TIMEOUT_MS, DEVICE_REDIRECT_URI, DEVICE_VERIFICATION_URI,
	exchangeAuthorizationCode, parseAuthorizationInput, pollDeviceAuthOnce, refreshCredentials, REDIRECT_URI, startDeviceAuth,
} from "./oauth.ts";
import { fetchCodexCatalog } from "./catalog.ts";
import { mergeCatalog, staticModels } from "./models.ts";
import { validSecret } from "../../shared/index.ts";
import type { AnyModel } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "codex-subscription";
export const DISPLAY_NAME = "Codex Subscription (experimental)";
export const BASE_URL = "https://chatgpt.com/backend-api";
export const METHOD_BROWSER = "browser";
export const METHOD_DEVICE = "device_code";

interface Dependencies extends HttpOptions {
	models: NonNullable<ProviderConfig["models"]>;
	streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
	now?: () => number;
	sleep?: typeof waitFor;
	/** Override the catalog host. Defaults to the host observed in the `codex` CLI. */
	baseUrl?: string;
	/** Injectable so tests never bind port 1455. */
	startLoopback?: (options: LoopbackOptions) => Promise<LoopbackServer>;
}

function randomState(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createCodexProvider(deps: Dependencies): ProviderConfig {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? waitFor;
	const listen = deps.startLoopback ?? startLoopback;
	const http = (signal?: AbortSignal): HttpOptions & { now: () => number } => ({ fetchImpl: deps.fetchImpl, signal, now });

	async function browserLogin(callbacks: OAuthLoginCallbacks) {
		const { verifier, challenge } = await generatePKCE();
		callbacks.signal?.throwIfAborted();
		const state = randomState();
		// Port 1455 is shared with the Codex CLI; if it is taken, fall back to a pasted redirect URL.
		const loopback = await listen({ port: CALLBACK_PORT, path: CALLBACK_PATH, state, signal: callbacks.signal }).catch(() => undefined);
		try {
			callbacks.onAuth({
				url: buildAuthorizeUrl({ state, codeChallenge: challenge }),
				instructions: loopback
					? "A browser window should open. Complete sign-in to finish."
					: `Sign in, then paste the full redirect URL (it starts with ${REDIRECT_URI}).`,
			});
			const manual = callbacks.onManualCodeInput
				?? (loopback ? undefined : () => callbacks.onPrompt({
					message: "Paste the full redirect URL from your browser:", placeholder: REDIRECT_URI,
				}));
			const input = await awaitAuthorizationInput({ loopback, manual });
			callbacks.signal?.throwIfAborted();
			let code: string;
			if (input.type === "callback") code = input.code;
			else {
				const parsed = parseAuthorizationInput(input.input, state);
				if (!parsed) throw new Error("Invalid authorization response or missing/mismatched state. Paste the full redirect URL from this sign-in, or restart /login.");
				code = parsed.code;
			}
			callbacks.onProgress?.("Exchanging authorization code…");
			return await exchangeAuthorizationCode({ code, codeVerifier: verifier, redirectUri: REDIRECT_URI, ...http(callbacks.signal) });
		} finally {
			loopback?.close();
		}
	}

	async function deviceLogin(callbacks: OAuthLoginCallbacks) {
		const total = AbortSignal.timeout(DEVICE_CODE_TIMEOUT_MS);
		const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, total]) : total;
		const device = await startDeviceAuth({ fetchImpl: deps.fetchImpl, signal });
		callbacks.onDeviceCode({
			userCode: device.userCode, verificationUri: DEVICE_VERIFICATION_URI,
			intervalSeconds: device.intervalSeconds, expiresInSeconds: DEVICE_CODE_TIMEOUT_MS / 1000,
		});
		const grant = await pollUntil({
			deadline: now() + DEVICE_CODE_TIMEOUT_MS, intervalMs: device.intervalSeconds * 1000,
			delayFirst: true, signal, now, sleep,
			onPending: () => callbacks.onProgress?.("Waiting for Codex sign-in approval…"),
			poll: () => pollDeviceAuthOnce(device, { fetchImpl: deps.fetchImpl, signal }),
		});
		callbacks.onProgress?.("Exchanging authorization code…");
		return exchangeAuthorizationCode({
			code: grant.authorizationCode, codeVerifier: grant.codeVerifier, redirectUri: DEVICE_REDIRECT_URI, ...http(signal),
		});
	}

	async function login(callbacks: OAuthLoginCallbacks) {
		callbacks.signal?.throwIfAborted();
		// A host that cannot show a selection (returns undefined) gets the default browser flow.
		const method = (await callbacks.onSelect({
			message: "Select Codex sign-in method:",
			options: [
				{ id: METHOD_BROWSER, label: "Browser sign-in (default)" },
				{ id: METHOD_DEVICE, label: "Device code sign-in (headless)" },
			],
		})) ?? METHOD_BROWSER;
		callbacks.signal?.throwIfAborted();
		if (method === METHOD_DEVICE) return deviceLogin(callbacks);
		if (method === METHOD_BROWSER) return browserLogin(callbacks);
		throw new Error("Unknown Codex sign-in method.");
	}

	return {
		name: DISPLAY_NAME,
		baseUrl: BASE_URL,
		api: "openai-codex-responses",
		models: deps.models,
		streamSimple: deps.streamSimple,
		oauth: {
			name: DISPLAY_NAME,
			isSubscription: true,
			login,
			refreshToken: (credentials, signal) => refreshCredentials(credentials, http(signal)),
			getApiKey: (credentials) => credentials.access,
		},
		refreshModels: async (context) => {
			// Pi's static catalog is always the fallback: discovery is an
			// improvement, never a dependency. Any failure leaves the user with
			// exactly the models they had before.
			const fallback = staticModels();
			// Restore first: a persisted catalog survives restarts, which is the
			// point of persisting below.
			if (!context.allowNetwork) {
				const stored = (context as { stored?: { models?: unknown[] } }).stored;
				const restored = stored?.models?.filter((m): m is ProviderModelConfig =>
					typeof m === "object" && m !== null && Array.isArray((m as { input?: unknown }).input)) ?? [];
				return restored.length > 0 ? restored : fallback;
			}
			const credential = context.credential as { access?: unknown } | undefined;
			if (!credential || !validSecret(credential.access)) return fallback;
			try {
				const remote = await fetchCodexCatalog(credential.access, {
					fetchImpl: deps.fetchImpl, signal: context.signal, baseUrl: deps.baseUrl,
				});
				// An empty catalog means "nothing to offer", which is worse than
				// the static list, so it is treated as a failed refresh.
				if (remote.length === 0) return fallback;
				const listed = mergeCatalog(remote, fallback).map((m) => ({ ...m, provider: PROVIDER_ID })) as unknown as ProviderModelConfig[];
				// Persist so the discovered catalog survives restarts; Pi writes
				// only what we publish. (models-store.json, not credentials.)
				await context.publish({ persist: { models: listed as unknown as AnyModel[], checkedAt: (deps.now ?? Date.now)() } });
				return listed;
			} catch {
				// The endpoint is unverified, so a 404 must not surface as an error
				// for a feature that is strictly optional.
				return fallback;
			}
		},
	};
}
