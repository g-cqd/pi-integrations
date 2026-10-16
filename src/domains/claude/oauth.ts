/**
 * Experimental Claude OAuth protocol helper: PKCE, exchange, refresh, and revoke.
 * Endpoint/client constants originated in a local Claude Code 2.1.301 investigation;
 * this is not an Anthropic-published third-party OAuth contract.
 * Network helpers accept injected fetch implementations for offline testing.
 */

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Observed subscription authorization endpoint, distinct from Console login.
export const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const REVOKE_URL = "https://platform.claude.com/v1/oauth/token/revoke";
export const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
// Broad scope set observed in that client. Not minimized or a promise of grants.
// Consent can include permissions beyond this adapter's inference needs; see README.
export const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins";

/** Token-endpoint response (identical shape for code and refresh grants). */
export interface TokenResponse {
	token_type: string;
	access_token: string;
	expires_in: number;
	refresh_token: string;
	scope: string;
	token_uuid?: string;
	refresh_token_expires_in?: number;
	organization?: { uuid?: string; name?: string };
	account?: { uuid?: string; email_address?: string };
}

/** Provider credentials (superset of pi's OAuthCredentials). */
export interface Credentials {
	access: string;
	refresh: string;
	expires: number;
	refreshExpires?: number;
	account_email?: string;
	org_name?: string;
	scopes?: string;
	[key: string]: unknown;
}

export type { FetchImplementation, HttpOptions as FetchOptions } from "../../shared/http.ts";
import { requestText, type HttpOptions as FetchOptions } from "../../shared/http.ts";

const EXPIRY_SAFETY_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export { generatePKCE } from "../../shared/pkce.ts";

// ---------------------------------------------------------------------------
// Authorization URL + code extraction
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(params: {
	state: string;
	codeChallenge: string;
	/** Pin the login to one organization (Claude Code's orgUUID param). */
	orgUUID?: string;
	/** Pre-fill the sign-in email (Claude Code's login_hint param). */
	loginHint?: string;
}): string {
	const query = new URLSearchParams({
		// "code=true" selects the paste-the-code flow (from W0r() in the binary)
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		state: params.state,
		code_challenge: params.codeChallenge,
		code_challenge_method: "S256",
	});
	if (params.orgUUID) query.append("orgUUID", params.orgUUID);
	if (params.loginHint) query.append("login_hint", params.loginHint);
	return `${AUTHORIZE_URL}?${query.toString()}`;
}

/** Parsed pasted authorization: the code plus the page's state when present. */
export interface ParsedAuthorization {
	code: string;
	state?: string;
}

/**
 * Parse code#state or an approved callback/success URL (query or fragment).
 * Bare codes are parseable for low-level callers only. The Pi login flow always
 * supplies expectedState, requiring a matching nonempty state for every format.
 */
export function parseAuthorizationCode(
	pasted: string,
	expectedState?: string,
): ParsedAuthorization | null {
	const text = pasted.trim();
	if (!text || text.length > 4096) return null;
	let parsed: ParsedAuthorization | null = null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
		let url: URL;
		try { url = new URL(text); } catch { return null; }
		if (url.origin !== "https://platform.claude.com" || url.username || url.password ||
			!["/oauth/code/callback", "/oauth/code/success"].includes(url.pathname)) return null;
		const fragment = new URLSearchParams(url.hash.slice(1));
		const values = (key: string) => [...url.searchParams.getAll(key), ...fragment.getAll(key)];
		const codes = values("code"), states = values("state");
		if (codes.length !== 1 || states.length > 1 || values("error").length) return null;
		if (!/^[A-Za-z0-9_.~-]{10,200}$/.test(codes[0])) return null;
		if (states.length && !/^[A-Za-z0-9_.~-]{1,200}$/.test(states[0])) return null;
		parsed = { code: codes[0], ...(states.length ? { state: states[0] } : {}) };
	} else {
		const pairs = [...text.matchAll(/(?<![A-Za-z0-9_.~#-])([A-Za-z0-9_.~-]{20,200})#([A-Za-z0-9_.~-]{1,200})(?![A-Za-z0-9_.~#-])/g)];
		if (pairs.length === 1) parsed = { code: pairs[0][1], state: pairs[0][2] };
		else if (pairs.length === 0 && /^[A-Za-z0-9_.~-]{20,200}$/.test(text)) parsed = { code: text };
	}
	if (expectedState !== undefined && (!expectedState || parsed?.state !== expectedState)) return null;
	return parsed;
}

// ---------------------------------------------------------------------------
// Token endpoint calls
// ---------------------------------------------------------------------------

const OAUTH_ERROR_CODES = new Set([
	"invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
	"unsupported_grant_type", "invalid_scope", "access_denied", "temporarily_unavailable",
]);

/** Shared transport owns cancellation, bounds, redirect refusal, and safe failures. */
async function credentialRequest(url: string, body: Record<string, string>, opts: FetchOptions) {
	return requestText(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" },
		body: JSON.stringify(body),
	}, opts);
}

async function postToken(
	body: Record<string, string>,
	opts: FetchOptions = {},
): Promise<TokenResponse> {
	const { response, text } = await credentialRequest(TOKEN_URL, body, opts);
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { /* invalid JSON, never echo it */ }
	if (!response.ok) {
		const rawCode = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).error : undefined;
		const code = typeof rawCode === "string" && OAUTH_ERROR_CODES.has(rawCode) ? rawCode : undefined;
		const recovery = code === "invalid_grant" ? " The authorization grant is invalid or expired. Run /login again." : "";
		throw new Error(`Claude token endpoint returned ${response.status}${code ? ` (${code})` : ""}.${recovery}`);
	}
	validateTokenResponse(parsed);
	return parsed;
}

function validateTokenResponse(value: unknown): asserts value is TokenResponse {
	const invalid = () => { throw new Error("Invalid credential response from token endpoint."); };
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const t = value as Record<string, unknown>;
	const validToken = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 16384 && !/\s/.test(v);
	const validTTL = (v: unknown) => typeof v === "number" && v > 0 &&
		Number.isSafeInteger(v * 1000) && Date.now() + v * 1000 <= 8.64e15;
	if (!validToken(t.access_token) || !validToken(t.refresh_token) ||
		typeof t.token_type !== "string" || t.token_type.toLowerCase() !== "bearer" ||
		!validTTL(t.expires_in) || typeof t.scope !== "string" ||
		(t.refresh_token_expires_in !== undefined && !validTTL(t.refresh_token_expires_in))) return invalid();
	for (const [key, field] of [["account", "email_address"], ["organization", "name"]] as const) {
		const metadata = t[key];
		if (metadata === undefined) continue;
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return invalid();
		const label = (metadata as Record<string, unknown>)[field];
		if (label !== undefined && typeof label !== "string") return invalid();
	}
}

export function toCredentials(t: TokenResponse): Credentials {
	validateTokenResponse(t);
	const now = Date.now();
	const lifetime = t.expires_in * 1000;
	return {
		access: t.access_token,
		refresh: t.refresh_token,
		expires: now + lifetime - Math.min(EXPIRY_SAFETY_MS, lifetime / 10),
		...(t.refresh_token_expires_in !== undefined
			? { refreshExpires: now + t.refresh_token_expires_in * 1000 }
			: {}),
		...(t.account?.email_address ? { account_email: t.account.email_address } : {}),
		...(t.organization?.name ? { org_name: t.organization.name } : {}),
		scopes: t.scope,
	};
}

/** OAuth authorization-code exchange. Success does not establish inference entitlement. */
export async function exchangeAuthorizationCode(params: {
	code: string;
	codeVerifier: string;
	state: string;
} & FetchOptions): Promise<Credentials> {
	const { code, codeVerifier, state, fetchImpl, signal } = params;
	const token = await postToken(
		{
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: CLIENT_ID,
			code_verifier: codeVerifier,
			state,
		},
		{ fetchImpl, signal },
	);
	return toCredentials(token);
}

/**
 * Refresh grant. Treat refresh tokens as rotating/single-use: persist the entire
 * replacement credential, and do not retry automatically after an uncertain result.
 */
export async function refreshCredentials(
	credentials: Pick<Credentials, "refresh">,
	opts: FetchOptions = {},
): Promise<Credentials> {
	const token = await postToken(
		{
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: CLIENT_ID,
		},
		opts,
	);
	return toCredentials(token);
}

/** Revoke the refresh token server-side (Claude Code's logout behavior). */
export async function revokeCredentials(
	refreshToken: string,
	opts: FetchOptions = {},
): Promise<void> {
	const { response } = await credentialRequest(REVOKE_URL, {
		token: refreshToken,
		token_type_hint: "refresh_token",
		client_id: CLIENT_ID,
	}, opts);
	if (!response.ok) {
		throw new Error(`Claude revoke endpoint returned ${response.status}`);
	}
}
