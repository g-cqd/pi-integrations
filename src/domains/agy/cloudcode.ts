/**
 * Cloud Code (`cloudcode-pa`) client for Antigravity: account/project discovery
 * and the live model catalog.
 *
 * Request and response shapes come from the protobuf descriptors embedded in the
 * shipped `agy` binary (v1internal LoadCodeAssist and FetchAvailableModels), and
 * the endpoint paths from the CLI's own request log. The client identity the
 * backend enforces is verified live (2026-10-17): it gates on the User-Agent
 * naming the Antigravity client, not on the metadata fields, so USER_AGENT leads
 * with `antigravity-<version>`; see USER_AGENT and docs/domains/agy.md. Failures
 * are reported with a credential-safe description (see describeFailure).
 */
import { record, requestText, safeBaseUrl, type HttpOptions } from "../../shared/index.ts";

/** What the shipped CLI actually calls (observed in its request log). */
export const DEFAULT_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
/** The production host constant also present in the binary. Select it with AGY_API_URL. */
export const PRODUCTION_BASE_URL = "https://cloudcode-pa.googleapis.com";
export const PLUGIN_VERSION = "0.1.0";
/**
 * The Antigravity client version this domain presents. Must lead the User-Agent
 * (see USER_AGENT): the backend gates the consumer Cloud Code project on the
 * UA naming the Antigravity client, established by live bisection on
 * 2026-10-17 — the same token and account receives a project with
 * `antigravity-1.4.0` in the UA and `ineligibleTiers: [UNSUPPORTED_CLIENT]`
 * without it. The metadata fields (ideName, versions) are NOT checked.
 */
export const CLIENT_VERSION = "1.4.0";
/**
 * Leads with the Antigravity client identity the backend gates on, and keeps
 * this package's own identity after it, so requests stay attributable. This is
 * a first-party identity claim required to use the account's own project; see
 * docs/domains/agy.md#terms for the risk assessment, the same call the Claude
 * gate documents.
 */
export const USER_AGENT = `antigravity-${CLIENT_VERSION} pi-integrations/${PLUGIN_VERSION} (agy-subscription)`;

export function resolveBaseUrl(env: Record<string, string | undefined> = process.env): string {
	return safeBaseUrl(env.AGY_API_URL?.trim() || DEFAULT_BASE_URL);
}

/** ClientMetadata.Platform enum name for this machine. */
export function platformName(platform: string = process.platform, arch: string = process.arch): string {
	const key = `${platform}/${arch}`;
	return ({
		"darwin/arm64": "DARWIN_ARM64", "darwin/x64": "DARWIN_AMD64",
		"linux/arm64": "LINUX_ARM64", "linux/x64": "LINUX_AMD64", "win32/x64": "WINDOWS_AMD64",
	} as Record<string, string>)[key] ?? "PLATFORM_UNSPECIFIED";
}

export function clientMetadata() {
	return { ideType: "ANTIGRAVITY", ideVersion: PLUGIN_VERSION, pluginVersion: PLUGIN_VERSION, platform: platformName(), ideName: "pi" };
}

export function requestHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		Accept: "application/json",
		"User-Agent": USER_AGENT,
	};
}

// ---------------------------------------------------------------------------
// Failure descriptions (credential-safe)
// ---------------------------------------------------------------------------

const SECRET_RE = /(ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]+|GOCSPX-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/g;
const ID_HEADERS = ["x-cloudaicompanion-trace-id", "x-goog-request-id", "x-request-id", "request-id"];

function clip(text: string, max: number): string {
	const clean = text.replace(/[\x00-\x1f\x7f]/g, " ").replace(SECRET_RE, "[redacted-token]").trim();
	return clean.length <= max ? clean : clean.slice(0, max) + "…";
}

const HINTS: Record<number, string> = {
	400: "The request shape may have changed or an assumed field was rejected; compare the message below.",
	401: "The access token was rejected. Run /login again.",
	403: "The account or project is not permitted to use this model through this client (tier, onboarding, or client identity). Check that Antigravity works for this account in the `agy` CLI.",
	404: "The model or method was not found for this account. Refresh the model list.",
	429: "Quota or rate limit reached for this model. Check usage in the `agy` CLI (/settings) and retry later.",
};

/** One-line-per-fact description: status, Google status code, redacted message, ids, retry hint. */
export function describeFailure(what: string, status: number, headers: Headers | Record<string, string>, bodyText: string): string {
	const get = (name: string) => headers instanceof Headers ? headers.get(name) ?? undefined : headers[name];
	const lines = [`${what} failed: HTTP ${status}.`];
	if (HINTS[status]) lines.push(HINTS[status]);
	else if (status >= 500) lines.push("The Antigravity backend reported a server error; retry later.");
	let parsed: unknown;
	try { parsed = JSON.parse(bodyText.slice(0, 4096)); } catch { /* not JSON */ }
	const error = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).error : undefined;
	if (error && typeof error === "object") {
		const e = error as Record<string, unknown>;
		if (typeof e.status === "string" && /^[A-Z_]{3,40}$/.test(e.status)) lines.push(`google status: ${e.status}`);
		if (typeof e.message === "string") lines.push(`message (truncated): ${clip(e.message, 240)}`);
	}
	for (const name of ID_HEADERS) {
		const value = get(name);
		if (value) { lines.push(`${name}: ${clip(value, 80)}`); break; }
	}
	const retryAfter = get("retry-after");
	if (retryAfter && /^[0-9]{1,6}$/.test(retryAfter)) lines.push(`retry-after: ${retryAfter}s`);
	return lines.join("\n");
}

async function post(url: string, body: unknown, accessToken: string, what: string, opts: HttpOptions): Promise<unknown> {
	const { response, text } = await requestText(url, {
		method: "POST", headers: requestHeaders(accessToken), body: JSON.stringify(body),
	}, opts);
	if (!response.ok) throw new Error(describeFailure(what, response.status, response.headers, text));
	try { return JSON.parse(text); } catch { throw new Error(`${what} returned an invalid response.`); }
}

// ---------------------------------------------------------------------------
// loadCodeAssist
// ---------------------------------------------------------------------------

export interface CodeAssistAccount { projectId: string; tierId?: string; tierName?: string }

/** Cloud project ids: alphanumeric start, no path separators. Shared with the stream so the two cannot drift. */
export const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const REASON_RE = /^[A-Z_]{3,64}$/;

/** Resolve the Cloud Code project (and tier) inference requests must carry. */
export async function loadCodeAssist(accessToken: string, opts: HttpOptions & { baseUrl: string }): Promise<CodeAssistAccount> {
	const json = record(await post(`${opts.baseUrl}/v1internal:loadCodeAssist`,
		{ metadata: clientMetadata(), mode: "FULL_ELIGIBILITY_CHECK" }, accessToken, "Antigravity account lookup", opts));
	const rawProject = json.cloudaicompanionProject;
	const projectId = typeof rawProject === "string" ? rawProject
		: rawProject && typeof rawProject === "object" ? (rawProject as Record<string, unknown>).id : undefined;
	const tier = [json.currentTier, json.paidTier].find((t) => t && typeof t === "object") as Record<string, unknown> | undefined;
	const tierId = typeof tier?.id === "string" && TIER_ID_RE.test(tier.id) ? tier.id : undefined;
	const tierName = typeof tier?.name === "string" ? clip(tier.name, 60) : undefined;
	if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
		const reasons = (Array.isArray(json.ineligibleTiers) ? json.ineligibleTiers : [])
			.map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>).reasonCode : undefined))
			.filter((r): r is string => typeof r === "string" && REASON_RE.test(r));
		throw new Error(
			`This Google account has no Antigravity Cloud Code project${tierName ? ` (tier: ${tierName})` : ""}.` +
			(reasons.length ? ` Ineligible: ${reasons.join(", ")}.` : "") +
			" Finish onboarding once in the `agy` CLI with this account, then run /login again.");
	}
	return { projectId, ...(tierId ? { tierId } : {}), ...(tierName ? { tierName } : {}) };
}

// ---------------------------------------------------------------------------
// fetchAvailableModels
// ---------------------------------------------------------------------------

export interface AvailableModel {
	id: string;
	displayName: string;
	supportsImages: boolean;
	supportsThinking: boolean;
	/** Context window in tokens, when the server reports one. */
	maxTokens?: number;
	maxOutputTokens?: number;
	recommended: boolean;
	preview: boolean;
}

export interface AvailableModels { models: AvailableModel[]; defaultModelId?: string }

const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const positiveInt = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined);

/**
 * The live agent-model catalog. Ids come from the server's agent model groups
 * (what `agy models` lists); without groups, every enabled, non-internal model.
 * Limits are taken as reported; nothing is guessed.
 */
export async function fetchAvailableModels(accessToken: string, opts: HttpOptions & { baseUrl: string; projectId: string }): Promise<AvailableModels> {
	const json = record(await post(`${opts.baseUrl}/v1internal:fetchAvailableModels`,
		{ project: opts.projectId }, accessToken, "Antigravity model list", opts));
	const map = json.models && typeof json.models === "object" && !Array.isArray(json.models) ? json.models as Record<string, unknown> : undefined;
	if (!map) throw new Error("Invalid Antigravity model list response.");

	const grouped: string[] = [];
	for (const sort of Array.isArray(json.agentModelSorts) ? json.agentModelSorts : []) {
		for (const group of Array.isArray((sort as Record<string, unknown>)?.groups) ? (sort as { groups: unknown[] }).groups : []) {
			for (const id of Array.isArray((group as Record<string, unknown>)?.modelIds) ? (group as { modelIds: unknown[] }).modelIds : []) {
				if (typeof id === "string" && !grouped.includes(id)) grouped.push(id);
			}
		}
	}
	const order = grouped.length ? grouped : Object.keys(map);
	const models: AvailableModel[] = [];
	for (const id of order) {
		const d = map[id];
		if (!MODEL_ID_RE.test(id) || !d || typeof d !== "object" || Array.isArray(d)) continue;
		const m = d as Record<string, unknown>;
		if (m.disabled === true || (!grouped.length && m.isInternal === true)) continue;
		models.push({
			id,
			displayName: typeof m.displayName === "string" && m.displayName.trim() ? clip(m.displayName, 80) : id,
			supportsImages: m.supportsImages === true,
			supportsThinking: m.supportsThinking === true,
			...(positiveInt(m.maxTokens) ? { maxTokens: positiveInt(m.maxTokens) } : {}),
			...(positiveInt(m.maxOutputTokens) ? { maxOutputTokens: positiveInt(m.maxOutputTokens) } : {}),
			recommended: m.recommended === true,
			preview: m.preview === true,
		});
	}
	const defaultId = json.defaultAgentModelId;
	return { models, ...(typeof defaultId === "string" && MODEL_ID_RE.test(defaultId) ? { defaultModelId: defaultId } : {}) };
}

