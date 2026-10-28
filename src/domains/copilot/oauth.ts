import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { pollUntil, record, requestJson, trustedUrl, validSecret, waitFor, type HttpOptions } from "../../shared/index.ts";
import { CLIENT_ID, copilotApiUrl, DEFAULT_API_URL, USER_AGENT, type InstallationIdentity } from "./protocol.ts";

export interface Dependencies extends HttpOptions { now?: () => number; sleep?: typeof waitFor }
export interface CopilotCredentials extends OAuthCredentials, InstallationIdentity { apiUrl: string }
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function installationIdentity(value: Record<string, unknown>): InstallationIdentity {
	if (!validSecret(value.machineId) || !validSecret(value.deviceId)) throw new Error("Invalid Copilot installation identity; restart /login.");
	return { machineId: value.machineId, deviceId: value.deviceId };
}

export async function exchangeCopilotToken(githubToken: string, identity: InstallationIdentity, deps: Dependencies): Promise<CopilotCredentials> {
	if (!validSecret(githubToken)) throw new Error("Invalid GitHub credential; restart /login.");
	const raw = record(await requestJson("https://api.github.com/copilot_internal/v2/token", {
		headers: { Authorization: `token ${githubToken}`, Accept: "application/json", "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2025-04-01" },
	}, deps));
	const now = (deps.now ?? Date.now)();
	if (!validSecret(raw.token) || !positive(raw.expires_at) || !positive(raw.refresh_in) ||
		!Number.isSafeInteger(now + raw.refresh_in * 1000) || raw.refresh_in > 86400) throw new Error("Invalid Copilot token envelope.");
	const endpoints = raw.endpoints === undefined ? {} : record(raw.endpoints);
	return {
		access: raw.token, refresh: githubToken,
		// VS Code schedules refresh using refresh_in, independent of wall-clock
		// skew in expires_at. Pi refreshes on the next credential resolution.
		expires: now + raw.refresh_in * 1000,
		apiUrl: copilotApiUrl(endpoints.api ?? DEFAULT_API_URL), ...identity,
	};
}

export async function loginCopilot(callbacks: OAuthLoginCallbacks, deps: Dependencies): Promise<CopilotCredentials> {
	callbacks.signal?.throwIfAborted();
	const raw = record(await requestJson("https://github.com/login/device/code", {
		method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
		body: new URLSearchParams({ client_id: CLIENT_ID, scope: "user:email" }),
	}, { ...deps, signal: callbacks.signal }));
	if (!validSecret(raw.device_code) || !validSecret(raw.user_code) || !positive(raw.interval) || !positive(raw.expires_in) ||
		raw.expires_in > 3600 || raw.interval > raw.expires_in) throw new Error("Invalid GitHub device-code response.");
	const verificationUri = trustedUrl(raw.verification_uri, "https://github.com/login/device");
	const now = deps.now ?? Date.now;
	const timeout = AbortSignal.timeout(raw.expires_in * 1000);
	const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, timeout]) : timeout;
	callbacks.onDeviceCode({ userCode: raw.user_code, verificationUri, intervalSeconds: raw.interval, expiresInSeconds: raw.expires_in });
	const deviceCode = raw.device_code;
	const token = await pollUntil<string>({
		deadline: now() + raw.expires_in * 1000, intervalMs: raw.interval * 1000,
		delayFirst: true, now, sleep: deps.sleep, signal,
		poll: async () => {
			const result = record(await requestJson("https://github.com/login/oauth/access_token", {
				method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
				body: new URLSearchParams({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
			}, { ...deps, signal }));
			if (validSecret(result.access_token)) return { state: "complete", value: result.access_token };
			if (result.error === "authorization_pending" || result.error === "slow_down") return { state: "pending", slowDown: result.error === "slow_down" };
			const code = ["access_denied", "expired_token", "incorrect_device_code"].includes(String(result.error)) ? result.error : "invalid_response";
			throw new Error(`GitHub device sign-in failed (${code}); restart /login.`);
		},
	});
	callbacks.onProgress?.("Creating Copilot session…");
	return exchangeCopilotToken(token, { machineId: crypto.randomUUID(), deviceId: crypto.randomUUID() }, { ...deps, signal });
}

/** Pi's string-only extension auth bridge carries endpoint + identity with the token. */
export function packCredential(credential: OAuthCredentials): string {
	if (!validSecret(credential.access)) throw new Error("Invalid Copilot credential; restart /login.");
	return JSON.stringify({ token: credential.access, apiUrl: copilotApiUrl(credential.apiUrl), ...installationIdentity(credential) });
}
export function unpackCredential(value: string | undefined) {
	try {
		if (!value || value.length > 32768) throw new Error();
		const raw = record(JSON.parse(value));
		if (!validSecret(raw.token)) throw new Error();
		return { token: raw.token, apiUrl: copilotApiUrl(raw.apiUrl), ...installationIdentity(raw) };
	} catch { throw new Error("Invalid Copilot request credential; sign in to copilot-vscode."); }
}
