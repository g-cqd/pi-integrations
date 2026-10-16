/**
 * Codex (ChatGPT subscription) sign-in protocol: browser authorization code
 * with PKCE (loopback callback or pasted redirect) and the headless device-code
 * flow, plus rotating refresh.
 *
 * This is the Codex CLI's own sign-in (its public client id), NOT the
 * "Sign in with ChatGPT" token-sharing flow. Endpoints and parameters follow the
 * flow Pi's bundled Codex login uses and the strings in the Codex CLI binary;
 * they are not a published third-party contract and may change. The account id
 * the inference backend needs is read from the access token's own claim.
 */
import {
	expiryAfter, jwtPayload, requestText, validSecret, type HttpOptions,
} from "../../shared/index.ts";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_BASE_URL = "https://auth.openai.com";
export const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
export const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
export const SCOPE = "openid profile email offline_access";
export const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
export const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
export const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
export const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
export const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
/** Claim holding the ChatGPT account id inside the access token. */
export const JWT_CLAIM = "https://api.openai.com/auth";
/** Identifies this client to the authorization server. Pi's own Codex login sends "pi". */
export const ORIGINATOR = "pi";

/** Credentials Pi stores. `accountId` is informational; the streamer re-reads it from the token. */
export interface CodexCredentials {
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
	[key: string]: unknown;
}

interface TokenResponse { access_token: string; refresh_token: string; expires_in: number }

export interface ClockOptions extends HttpOptions { now?: () => number }

// ---------------------------------------------------------------------------
// Authorization URL and pasted input
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(params: { state: string; codeChallenge: string; originator?: string }): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", params.state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", params.originator ?? ORIGINATOR);
	return url.toString();
}

const CODE_RE = /^[A-Za-z0-9_.~-]{10,512}$/;
const STATE_RE = /^[A-Za-z0-9_.~-]{1,200}$/;

/**
 * Parse what a user pastes after a browser sign-in whose callback server was
 * unavailable: the full redirect URL, `code#state`, or `code=...&state=...`.
 * The state must match in every form; there is no bare-code shortcut.
 */
export function parseAuthorizationInput(pasted: string, expectedState: string): { code: string } | null {
	const text = pasted.trim();
	if (!text || text.length > 4096 || !expectedState) return null;
	let code: string | undefined, state: string | undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
		let url: URL;
		try { url = new URL(text); } catch { return null; }
		const expected = new URL(REDIRECT_URI);
		if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password) return null;
		if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length !== 1) return null;
		code = url.searchParams.get("code") ?? undefined;
		state = url.searchParams.get("state") ?? undefined;
	} else if (text.includes("code=")) {
		const params = new URLSearchParams(text.replace(/^[?#]/, ""));
		if (params.has("error") || params.getAll("code").length !== 1 || params.getAll("state").length !== 1) return null;
		code = params.get("code") ?? undefined;
		state = params.get("state") ?? undefined;
	} else if (text.split("#").length === 2) {
		[code, state] = text.split("#");
	}
	if (!code || !state || !CODE_RE.test(code) || !STATE_RE.test(state) || state !== expectedState) return null;
	return { code };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

const OAUTH_ERROR_CODES = new Set([
	"invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type",
	"invalid_scope", "access_denied", "temporarily_unavailable", "expired_token", "slow_down",
	"refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated",
]);

function parseJson(text: string): unknown {
	try { return JSON.parse(text); } catch { return undefined; }
}

/** Provider error code from either {"error":"code"} or {"error":{"code":"code"}}. Never the description. */
function errorCodeOf(parsed: unknown): string | undefined {
	if (!parsed || typeof parsed !== "object") return undefined;
	const error = (parsed as Record<string, unknown>).error;
	const code = typeof error === "string" ? error
		: error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined;
	return typeof code === "string" ? code : undefined;
}

function oauthCode(parsed: unknown): string | undefined {
	const code = errorCodeOf(parsed);
	return code && OAUTH_ERROR_CODES.has(code) ? code : undefined;
}

async function tokenRequest(form: Record<string, string>, what: "exchange" | "refresh", opts: ClockOptions): Promise<TokenResponse> {
	const { response, text } = await requestText(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(form).toString(),
	}, opts);
	const parsed = parseJson(text);
	if (!response.ok) {
		const code = oauthCode(parsed);
		const recovery = code && /^(invalid_grant|refresh_token_)/.test(code)
			? " The grant is invalid, expired, or already used. Run /login again." : "";
		throw new Error(`Codex token ${what} returned ${response.status}${code ? ` (${code})` : ""}.${recovery}`);
	}
	return validateTokenResponse(parsed);
}

function validateTokenResponse(value: unknown): TokenResponse {
	const invalid = () => new Error("Invalid credential response from Codex token endpoint.");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const t = value as Record<string, unknown>;
	if (!validSecret(t.access_token) || !validSecret(t.refresh_token) || typeof t.expires_in !== "number") throw invalid();
	return { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in };
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** The ChatGPT account id claim of an access token, or undefined when absent or malformed. */
export function accountIdOf(accessToken: string): string | undefined {
	const claim = jwtPayload(accessToken)?.[JWT_CLAIM];
	const id = claim && typeof claim === "object" ? (claim as Record<string, unknown>).chatgpt_account_id : undefined;
	return typeof id === "string" && ACCOUNT_ID_RE.test(id) ? id : undefined;
}

export function toCredentials(token: TokenResponse, now: number): CodexCredentials {
	const accountId = accountIdOf(token.access_token);
	if (!accountId) throw new Error("Codex sign-in returned an access token without a ChatGPT account id.");
	return { access: token.access_token, refresh: token.refresh_token, expires: expiryAfter(now, token.expires_in), accountId };
}

/** Authorization-code exchange. A successful sign-in does not prove plan entitlement. */
export async function exchangeAuthorizationCode(params: {
	code: string; codeVerifier: string; redirectUri?: string;
} & ClockOptions): Promise<CodexCredentials> {
	const token = await tokenRequest({
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		code: params.code,
		code_verifier: params.codeVerifier,
		redirect_uri: params.redirectUri ?? REDIRECT_URI,
	}, "exchange", params);
	return toCredentials(token, (params.now ?? Date.now)());
}

/**
 * Refresh grant. Treat refresh tokens as rotating and single-use: Pi must persist
 * the whole replacement, and an uncertain result is never retried automatically.
 */
export async function refreshCredentials(credentials: Pick<CodexCredentials, "refresh">, opts: ClockOptions = {}): Promise<CodexCredentials> {
	const token = await tokenRequest({
		grant_type: "refresh_token",
		refresh_token: credentials.refresh,
		client_id: CLIENT_ID,
	}, "refresh", opts);
	return toCredentials(token, (opts.now ?? Date.now)());
}

// ---------------------------------------------------------------------------
// Device-code flow
// ---------------------------------------------------------------------------

export interface DeviceAuth { deviceAuthId: string; userCode: string; intervalSeconds: number }

const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const USER_CODE_RE = /^[A-Za-z0-9-]{3,64}$/;
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 60;

export async function startDeviceAuth(opts: HttpOptions = {}): Promise<DeviceAuth> {
	const { response, text } = await requestText(DEVICE_USER_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
	}, opts);
	if (response.status === 404) throw new Error("Codex device-code sign-in is not enabled for this server. Use the browser sign-in.");
	if (!response.ok) throw new Error(`Codex device-code request returned ${response.status}.`);
	const json = parseJson(text) as Record<string, unknown> | undefined;
	const rawInterval = typeof json?.interval === "string" ? Number(json.interval.trim()) : json?.interval;
	if (!json || typeof json.device_auth_id !== "string" || !DEVICE_ID_RE.test(json.device_auth_id) ||
		typeof json.user_code !== "string" || !USER_CODE_RE.test(json.user_code) ||
		typeof rawInterval !== "number" || !Number.isFinite(rawInterval) || rawInterval < 0) {
		throw new Error("Invalid Codex device-code response.");
	}
	return {
		deviceAuthId: json.device_auth_id,
		userCode: json.user_code,
		intervalSeconds: Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, rawInterval)),
	};
}

/** One poll of the device token endpoint, mapped to the shared poller's states. */
export async function pollDeviceAuthOnce(device: DeviceAuth, opts: HttpOptions = {}):
	Promise<{ state: "pending"; slowDown?: boolean } | { state: "complete"; value: { authorizationCode: string; codeVerifier: string } }> {
	const { response, text } = await requestText(DEVICE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
	}, opts);
	if (response.ok) {
		const json = parseJson(text) as Record<string, unknown> | undefined;
		if (!json || !validSecret(json.authorization_code) || !validSecret(json.code_verifier)) {
			throw new Error("Invalid Codex device-code token response.");
		}
		return { state: "complete", value: { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier } };
	}
	// 403/404 are how the server says "not approved yet".
	if (response.status === 403 || response.status === 404) return { state: "pending" };
	const code = errorCodeOf(parseJson(text));
	if (code === "deviceauth_authorization_pending") return { state: "pending" };
	if (code === "slow_down") return { state: "pending", slowDown: true };
	const known = code && (OAUTH_ERROR_CODES.has(code)) ? ` (${code})` : "";
	throw new Error(`Codex device-code sign-in failed with status ${response.status}${known}. Restart /login.`);
}
