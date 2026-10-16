/**
 * Antigravity (`agy`) Google-account sign-in: authorization code with PKCE and a
 * hosted "paste this code" callback page, then Google's token endpoint.
 *
 * Evidence: the authorization request below is the one the shipped `agy` CLI
 * prints for its "Google OAuth" method (captured in an isolated, never-signed-in
 * profile). The client is a Desktop-type Google client, so Google's token
 * endpoint requires its client secret (an anonymous probe answers "client_secret
 * is missing" without it). That secret is a credential of the Antigravity app
 * and is NEVER bundled here: it is read from the environment or from a local
 * file (see resolveClientSecret and docs/domains/agy.md). This is not a
 * published third-party contract and may change without notice.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	expiryAfter, jwtPayload, requestText, validSecret, type HttpOptions,
} from "../../shared/index.ts";

export const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Hosted page that displays the authorization code for the user to paste back. */
export const REDIRECT_URI = "https://antigravity.google/oauth-callback";
export const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
	"https://www.googleapis.com/auth/aicode",
	"openid",
] as const;
/**
 * The Antigravity Desktop client's OAuth client secret is an app credential: it
 * identifies the application to Google, not any user. It is read at run time
 * from, in order, the environment variable, then a local file. It is never
 * bundled in this repository, never logged, and never stored in credentials.
 */
export const CLIENT_SECRET_ENV = "AGY_OAUTH_CLIENT_SECRET";
/** Optional override for the file that holds the client secret. */
export const CLIENT_SECRET_FILE_ENV = "AGY_OAUTH_CLIENT_SECRET_FILE";
/** Default file location, outside any repository. `~` is expanded. */
export const DEFAULT_CLIENT_SECRET_FILE = "~/.config/pi-integrations/agy-oauth-client-secret";

export interface AgyCredentials {
	access: string;
	refresh: string;
	expires: number;
	scopes?: string;
	/** Display only, read from the ID token; never used for trust. */
	account_email?: string;
	/** Cloud Code project resolved at sign-in; inference requests must carry it. */
	projectId?: string;
	tierId?: string;
	[key: string]: unknown;
}

export interface OAuthOptions extends HttpOptions {
	now?: () => number;
	/** Supplies the client secret; defaults to the environment, then the configured file. */
	clientSecret?: () => string | undefined;
}

export function secretFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
	const value = env[CLIENT_SECRET_ENV]?.trim();
	return value ? value : undefined;
}

/** Reads a secret file. Injected so tests never touch the filesystem. */
export type ReadSecretFile = (path: string) => string | undefined;

/** A file read that tolerates a missing or unreadable file. */
export const readSecretFileSync: ReadSecretFile = (path) => {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined; // absent, unreadable, or a directory: treat as unset
	}
};

function expandHome(path: string): string {
	return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

/** The client secret from the configured file, or undefined when there is none. */
export function secretFromFile(
	env: Record<string, string | undefined> = process.env,
	readFile: ReadSecretFile = readSecretFileSync,
): string | undefined {
	const path = env[CLIENT_SECRET_FILE_ENV]?.trim() || DEFAULT_CLIENT_SECRET_FILE;
	return readFile(expandHome(path))?.trim() || undefined;
}

/** Environment first, then the file. Returns undefined when neither has one. */
export function resolveClientSecret(
	env: Record<string, string | undefined> = process.env,
	readFile: ReadSecretFile = readSecretFileSync,
): string | undefined {
	return secretFromEnv(env) ?? secretFromFile(env, readFile);
}

/**
 * Fail fast, before any browser link or request, when no usable client secret is
 * available. The message names both sources rather than describing the exchange.
 */
export function requireClientSecret(opts: OAuthOptions): string {
	const secret = (opts.clientSecret ?? (() => resolveClientSecret()))();
	if (!validSecret(secret)) {
		throw new Error(
			`Antigravity sign-in needs the Antigravity app's OAuth client secret. ` +
			`Set ${CLIENT_SECRET_ENV} or put it in ${DEFAULT_CLIENT_SECRET_FILE}; ` +
			`see docs/domains/agy.md for how to obtain it from your own agy install.`,
		);
	}
	return secret;
}

/** Same parameters, in the same alphabetical order, as the `agy` CLI's own sign-in link. */
export function buildAuthorizeUrl(params: { state: string; codeChallenge: string }): string {
	const query = new URLSearchParams([
		["access_type", "offline"],
		["client_id", CLIENT_ID],
		["code_challenge", params.codeChallenge],
		["code_challenge_method", "S256"],
		["prompt", "consent"],
		["redirect_uri", REDIRECT_URI],
		["response_type", "code"],
		["scope", SCOPES.join(" ")],
		["state", params.state],
	]);
	return `${AUTHORIZE_URL}?${query.toString()}`;
}

const CODE_RE = /^[A-Za-z0-9/_.~-]{10,512}$/;
const STATE_RE = /^[A-Za-z0-9_.~-]{1,200}$/;

/**
 * Parse what the user pastes. The hosted page shows the code itself, so a bare
 * code is accepted: PKCE binds it to this login's verifier, so an injected code
 * from another flow fails at exchange. A full redirect URL is also accepted, in
 * which case its state must match.
 */
export function parseAuthorizationInput(pasted: string, expectedState: string): { code: string } | null {
	const text = pasted.trim();
	if (!text || text.length > 4096) return null;
	let code: string | undefined, state: string | undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
		let url: URL;
		try { url = new URL(text); } catch { return null; }
		const expected = new URL(REDIRECT_URI);
		if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password) return null;
		if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length > 1) return null;
		code = url.searchParams.get("code") ?? undefined;
		state = url.searchParams.get("state") ?? undefined;
	} else if (text.includes("code=")) {
		const params = new URLSearchParams(text.replace(/^[?#]/, ""));
		if (params.has("error") || params.getAll("code").length !== 1 || params.getAll("state").length > 1) return null;
		code = params.get("code") ?? undefined;
		state = params.get("state") ?? undefined;
	} else {
		code = text;
	}
	if (!code || !CODE_RE.test(code)) return null;
	if (state !== undefined && (!STATE_RE.test(state) || state !== expectedState)) return null;
	return { code };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

const OAUTH_ERROR_CODES = new Set([
	"invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type",
	"invalid_scope", "access_denied", "temporarily_unavailable",
]);

interface TokenResponse { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string }

async function tokenRequest(form: Record<string, string>, what: "exchange" | "refresh", opts: OAuthOptions): Promise<TokenResponse> {
	const { response, text } = await requestText(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(form).toString(),
	}, opts);
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { /* never echo a non-JSON body */ }
	if (!response.ok) {
		const raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).error : undefined;
		const code = typeof raw === "string" && OAUTH_ERROR_CODES.has(raw) ? raw : undefined;
		const recovery = code === "invalid_grant" ? " The grant is invalid, expired, or already used. Run /login again." : "";
		throw new Error(`Antigravity token ${what} returned ${response.status}${code ? ` (${code})` : ""}.${recovery}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid credential response from Antigravity token endpoint.");
	const t = parsed as Record<string, unknown>;
	if (!validSecret(t.access_token) || typeof t.expires_in !== "number" ||
		typeof t.token_type !== "string" || t.token_type.toLowerCase() !== "bearer" ||
		(t.refresh_token !== undefined && !validSecret(t.refresh_token)) ||
		(t.scope !== undefined && typeof t.scope !== "string")) {
		throw new Error("Invalid credential response from Antigravity token endpoint.");
	}
	return {
		access_token: t.access_token, expires_in: t.expires_in,
		...(typeof t.refresh_token === "string" ? { refresh_token: t.refresh_token } : {}),
		...(typeof t.scope === "string" ? { scope: t.scope } : {}),
		...(typeof t.id_token === "string" ? { id_token: t.id_token } : {}),
	};
}

/** Conservative on purpose: this string is displayed, so only ordinary address characters pass. */
const EMAIL_RE = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;

function emailOf(idToken: string | undefined): string | undefined {
	const email = idToken ? jwtPayload(idToken)?.email : undefined;
	return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email) ? email : undefined;
}

/** Authorization-code exchange. Success does not prove the account has Cloud Code access. */
export async function exchangeAuthorizationCode(params: { code: string; codeVerifier: string } & OAuthOptions): Promise<AgyCredentials> {
	const secret = requireClientSecret(params);
	const token = await tokenRequest({
		grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: secret,
		code: params.code, code_verifier: params.codeVerifier, redirect_uri: REDIRECT_URI,
	}, "exchange", params);
	if (!token.refresh_token) {
		throw new Error("Antigravity sign-in returned no refresh token, so the session could not be renewed. Run /login again.");
	}
	const email = emailOf(token.id_token);
	return {
		access: token.access_token,
		refresh: token.refresh_token,
		expires: expiryAfter((params.now ?? Date.now)(), token.expires_in),
		...(token.scope ? { scopes: token.scope } : {}),
		...(email ? { account_email: email } : {}),
	};
}

/**
 * Refresh grant. Google normally keeps the refresh token, so an absent
 * `refresh_token` in the response keeps the stored one; any extra fields stored
 * with the credential (project, tier, email) are carried forward unchanged.
 */
export async function refreshCredentials(credentials: AgyCredentials, opts: OAuthOptions = {}): Promise<AgyCredentials> {
	const secret = requireClientSecret(opts);
	const token = await tokenRequest({
		grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: secret, refresh_token: credentials.refresh,
	}, "refresh", opts);
	return {
		...credentials,
		access: token.access_token,
		refresh: token.refresh_token ?? credentials.refresh,
		expires: expiryAfter((opts.now ?? Date.now)(), token.expires_in),
		...(token.scope ? { scopes: token.scope } : {}),
	};
}
