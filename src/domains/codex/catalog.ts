/**
 * The live Codex model-catalog request, kept separate from the mapping in
 * models.ts so the parsing rules can be tested without a network.
 *
 * Endpoint evidence is in models.ts. This module owns only the request shape,
 * the credential-safe failure description, and the parsing rules.
 */
import { requestText, validSecret, type HttpOptions } from "../../shared/index.ts";

/** Host and path observed in the `codex` CLI (see models.ts for the evidence). */
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_MODELS_PATH = "/codex/models";

/** A model as this client understands it, after validation. */
export interface CodexModelInfo {
	slug: string;
	displayName?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	supportedReasoningLevels: string[];
	defaultReasoningLevel?: string;
	visibility?: string;
	supportedInApi?: boolean;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEVEL_RE = /^[a-z]{2,24}$/;
const VISIBILITY_RE = /^[A-Za-z0-9_]{1,32}$/;
const positiveInt = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined);

/** Narrow an unknown value to a plain object, excluding arrays and null. */
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
	(v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

/** Strip control characters and clamp a display string; never echoes a token. */
function clip(text: string, max: number): string {
	const clean = text.replace(/[\x00-\x1f\x7f]/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * Token shapes a provider might echo back in an error message. Matches the
 * Antigravity domain's rule so a failure description is safe in both domains:
 * a message must never become a place a credential is written down.
 */
const SECRET_RE = /(ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]+|GOCSPX-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/g;

/**
 * Credential-safe one-line-per-fact failure description. Mirrors the Antigravity
 * `describeFailure` shape so both domains report a 403 the same way.
 */
export function describeFailure(what: string, status: number, bodyText: string): string {
	const lines = [`${what} failed: HTTP ${status}.`];
	if (status === 401) lines.push("The access token was rejected. Run /login again.");
	else if (status === 403) lines.push("This account or plan may not list models through this client. Pi's static catalog is used instead.");
	else if (status === 404) lines.push("This server does not expose a model catalog at the expected path. Pi's static catalog is used instead.");
	else if (status === 429) lines.push("Rate limited by ChatGPT. Pi's static catalog is used instead.");
	else if (status >= 500) lines.push("The server reported an error. Pi's static catalog is used instead.");
	try {
		const parsed = JSON.parse(bodyText.slice(0, 4096)) as { error?: { message?: unknown } | string };
		const error = parsed?.error;
		const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : undefined;
		if (message) lines.push(`message: ${clip(message, 200).replace(SECRET_RE, "[redacted-token]")}`);
	} catch { /* not JSON */ }
	return lines.join("\n");
}

/**
 * Pull the model array out of the response.
 *
 * The CLI's JSON envelope is not pinned by its strings, so this accepts the
 * models at the top level, under `models`, or nested one level down. Anything
 * else is treated as an unusable response rather than an empty catalog: an empty
 * list would look like "your plan has no models", which is a different and
 * wrong conclusion.
 */
export function parseCatalog(body: unknown): CodexModelInfo[] | undefined {
	// A bare array is a legitimate envelope, so it is handled before the record
	// narrowing that would otherwise reject it.
	if (Array.isArray(body)) return catalogFrom(body);
	const root = asRecord(body);
	if (!root) return undefined;
	let list: unknown;
	if (Array.isArray(root.models)) list = root.models;
	else {
		for (const nested of Object.values(root)) {
			const record = asRecord(nested);
			const inner = record && Array.isArray(record.models) ? record.models : undefined;
			if (inner) { list = inner; break; }
		}
	}
	if (!Array.isArray(list)) return undefined;
	return catalogFrom(list);
}

/** Validate one list of entries into models, skipping malformed ones. */
function catalogFrom(list: unknown[]): CodexModelInfo[] {
	const models: CodexModelInfo[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		const record = asRecord(entry);
		if (!record) continue;
		// Accept `slug`, and `id` as the fallback some serializers use.
		const rawSlug = typeof record.slug === "string" ? record.slug : typeof record.id === "string" ? record.id : undefined;
		if (!rawSlug || !SLUG_RE.test(rawSlug)) continue;
		// "unique, non-empty model slugs" is the CLI's own catalog rule.
		if (seen.has(rawSlug)) continue;
		seen.add(rawSlug);
		const levels = Array.isArray(record.supported_reasoning_levels ?? record.supportedReasoningLevels)
			? (record.supported_reasoning_levels ?? record.supportedReasoningLevels) as unknown[]
			: [];
		const defaultLevel = record.default_reasoning_level ?? record.defaultReasoningLevel;
		models.push({
			slug: rawSlug,
			displayName: typeof (record.display_name ?? record.displayName) === "string"
				? clip(String(record.display_name ?? record.displayName), 80) : undefined,
			contextWindow: positiveInt(record.context_window ?? record.contextWindow),
			maxOutputTokens: positiveInt(record.max_output_tokens ?? record.maxOutputTokens),
			supportedReasoningLevels: levels.filter((l): l is string => typeof l === "string" && LEVEL_RE.test(l)),
			defaultReasoningLevel: typeof defaultLevel === "string" && LEVEL_RE.test(defaultLevel) ? defaultLevel : undefined,
			visibility: typeof record.visibility === "string" && VISIBILITY_RE.test(record.visibility) ? record.visibility : undefined,
			supportedInApi: typeof (record.supported_in_api ?? record.supportedInApi) === "boolean"
				? Boolean(record.supported_in_api ?? record.supportedInApi) : undefined,
		});
	}
	return models;
}

/**
 * Fetch the account's catalog. Requires the access token; the backend refuses
 * anonymous calls, so this is never attempted without one.
 */
export async function fetchCodexCatalog(accessToken: string, opts: HttpOptions & { baseUrl?: string } = {}): Promise<CodexModelInfo[]> {
	if (!validSecret(accessToken)) throw new Error("No Codex access token for the model catalog. Run /login.");
	const base = opts.baseUrl ?? CODEX_API_BASE_URL;
	const { response, text } = await requestText(`${base}${CODEX_MODELS_PATH}`, {
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
	}, opts);
	if (!response.ok) throw new Error(describeFailure("Codex model catalog", response.status, text));
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { throw new Error("Codex model catalog returned an invalid response."); }
	const models = parseCatalog(parsed);
	// An unparseable envelope is a failure, not an empty catalog.
	if (models === undefined) throw new Error("Codex model catalog returned an unrecognized response shape.");
	return models;
}
