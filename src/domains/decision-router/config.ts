/**
 * Configuration and tier catalog for the `decision-router` virtual model layer.
 *
 * Thinking levels in Pi (`low`, `medium`, `high`, `xhigh`) are mapped to the
 * router's four conceptual modes:
 *   - `low`    -> Lowest tier (Apple Foundation Models local 3B, Spettro Velo 3.1 Flash [free, Sonnet-level], Gemini 3.5 Flash Lite, Claude Haiku 5.5, GPT-6 Luna)
 *   - `medium` -> Medium tier (Spettro Velo 3.1 Flash [free, Sonnet-level], Claude Sonnet 5.5, Gemini 3.8 Flash Medium, GPT-5.6 Terra, Gemini 4 Argon Medium, Mistral Large 4)
 *   - `high`   -> Highest tier (Claude Opus 5.5, GPT-6.1 Sol, Gemini 4 Argon High, Claude Fable 5.1, GPT-6 Astra)
 *   - `xhigh`  -> Auto (Decision Model `vllm-d3-lite` / `Laya` / `Jev` picks the tier `lowest` | `medium` | `highest` and task profile,
 *                 then the multi-objective utility scorer selects the optimal candidate)
 *
 * Every model and every subscription carries explicit `estimatedAccuracy` (in [0, 1])
 * and `estimatedLatencyMs` (time-to-first-useful-turn in milliseconds) grounded
 * in the latest 2026-10-17 benchmarks and pricing data.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type DecisionTier = "lowest" | "medium" | "highest";
export type TaskProfile = "quick_edit" | "code_implementation" | "deep_architecture";

export interface SubscriptionEstimate {
	provider: string;
	displayName: string;
	/** Baseline expected accuracy across the subscription's primary coding models in [0, 1]. */
	estimatedAccuracy: number;
	/** Baseline median first-turn latency (ms) for this subscription's transport. */
	estimatedLatencyMs: number;
}

export interface CandidateSpec {
	provider: string;
	id: string;
	/** Physical thinking level passed to the routed model when dispatched. */
	thinkingLevel: ModelThinkingLevel;
	/** Estimated coding/reasoning accuracy in [0, 1] from current benchmarks. */
	estimatedAccuracy: number;
	/** Estimated median latency (ms) to first useful response turn. */
	estimatedLatencyMs: number;
	/** Legacy alias kept equal to `estimatedAccuracy` for config compatibility. */
	quality: number;
	/** Bonus added when the classifier's task_profile matches a specialization. */
	strengths?: Partial<Record<TaskProfile, number>>;
	/** List-price estimate (USD / 1M input tokens) from verified 2026-10-17 vendor tables. */
	estimatedInputUsdPerM?: number;
	/** List-price estimate (USD / 1M output tokens). */
	estimatedOutputUsdPerM?: number;
	/** True for free local on-device models (e.g. Apple Foundation Models). */
	localOnly?: boolean;
	/** True for zero-cost / free cloud models (e.g. Spettro Velo 3.1 Flash) that preserve paid quota. */
	freeModel?: boolean;
}

export interface ClassifierEndpointSpec {
	/** Label for diagnostics. */
	name: string;
	/** Either a Pi registry classifier (`provider` + `id`) or a direct System One HTTP endpoint. */
	kind: "pi-registry" | "system-one-http";
	provider?: string;
	id?: string;
	url?: string;
	model?: string;
	timeoutMs?: number;
	/** Measured single-pass classification latency (ms) on Apple Silicon M2 Pro. */
	estimatedLatencyMs: number;
	/** Measured or published benchmark accuracy in [0, 1]. */
	estimatedAccuracy: number;
}

export interface DecisionRouterConfig {
	/** Ordered list of decision classifiers to try. First reachable wins; falls back to heuristic if all fail. */
	classifiers: ClassifierEndpointSpec[];
	/** Subscription-level accuracy and latency baselines. */
	subscriptions: Record<string, SubscriptionEstimate>;
	/** How long to cache live subscription quota snapshots (ms). */
	quotaCacheTtlMs: number;
	/** Candidate pools per conceptual thinking tier. */
	tiers: Record<DecisionTier, CandidateSpec[]>;
	/** Weights for the multi-objective utility scorer. */
	weights: {
		accuracy: number;
		latencyPenalty: number;
		quotaHeadroom: number;
		costPenalty: number;
		cacheStickiness: number;
		localBonus: number;
		freeModelBonus: number;
	};
}

export const CONFIG_ENV = "PI_DECISION_ROUTER_CONFIG";
export const DEFAULT_CONFIG_PATH = "~/.config/pi-integrations/decision-router.json";
export const LOCAL_SYSTEMONE_URL_ENV = "PI_DECISION_ROUTER_URL";
export const DEFAULT_LOCAL_SYSTEMONE_URL = "http://127.0.0.1:18080/v1/systemone";

export const DEFAULT_ROUTER_CONFIG: DecisionRouterConfig = {
	classifiers: [
		{
			name: "vllm-d3-lite (local System One)",
			kind: "system-one-http",
			url: DEFAULT_LOCAL_SYSTEMONE_URL,
			model: "vllm-d3-lite-Q8_0.gguf",
			timeoutMs: 1500,
			estimatedLatencyMs: 325,
			estimatedAccuracy: 0.92,
		},
		{
			name: "llama.cpp decision model (Pi registry)",
			kind: "pi-registry",
			provider: "llama.cpp",
			id: "vllm-d3-lite-Q8_0.gguf",
			timeoutMs: 1500,
			estimatedLatencyMs: 325,
			estimatedAccuracy: 0.92,
		},
		{
			name: "Laya (local System One)",
			kind: "pi-registry",
			provider: "llama.cpp",
			id: "Laya-Q8_0.gguf",
			timeoutMs: 1500,
			estimatedLatencyMs: 122,
			estimatedAccuracy: 0.84,
		},
		{
			name: "TypeSafe Jev (cloud classifier)",
			kind: "pi-registry",
			provider: "typesafe",
			id: "jev-latest",
			timeoutMs: 2500,
			estimatedLatencyMs: 260,
			estimatedAccuracy: 0.94,
		},
		{
			name: "OpenRouter Mercury Decide (free cloud classifier)",
			kind: "pi-registry",
			provider: "openrouter",
			id: "inception/mercury-decide:free",
			timeoutMs: 2500,
			estimatedLatencyMs: 310,
			estimatedAccuracy: 0.88,
		},
	],
	subscriptions: {
		"apple-foundation": {
			provider: "apple-foundation",
			displayName: "Apple Foundation Models (On-Device 3B)",
			estimatedAccuracy: 0.68,
			estimatedLatencyMs: 420,
		},
		"spettro": {
			provider: "spettro",
			displayName: "Spettro Subscription (incl. free Velo 3.1 Flash at Sonnet-level accuracy)",
			estimatedAccuracy: 0.91,
			estimatedLatencyMs: 680,
		},
		"claude-subscription": {
			provider: "claude-subscription",
			displayName: "Claude Subscription (Haiku 5.5 · Sonnet 5.5 · Opus 5.5 · Fable 5.1)",
			estimatedAccuracy: 0.95,
			estimatedLatencyMs: 1150,
		},
		"codex-subscription": {
			provider: "codex-subscription",
			displayName: "Codex Subscription (GPT-6 Luna · GPT-5.6 Terra · GPT-6.1 Sol · GPT-6 Astra)",
			estimatedAccuracy: 0.95,
			estimatedLatencyMs: 1250,
		},
		"agy-subscription": {
			provider: "agy-subscription",
			displayName: "Antigravity Subscription (Gemini 3.8 Flash · Gemini 4 Argon · Claude 5.5)",
			estimatedAccuracy: 0.93,
			estimatedLatencyMs: 950,
		},
		"mistral-vibe": {
			provider: "mistral-vibe",
			displayName: "Mistral Vibe (Mistral Large 4)",
			estimatedAccuracy: 0.87,
			estimatedLatencyMs: 980,
		},
	},
	quotaCacheTtlMs: 60_000,
	weights: {
		accuracy: 0.48,
		latencyPenalty: 0.14,
		quotaHeadroom: 0.30,
		costPenalty: 0.12,
		cacheStickiness: 0.15,
		localBonus: 0.25,
		freeModelBonus: 0.16,
	},
	tiers: {
		lowest: [
			{
				provider: "apple-foundation",
				id: "apple-foundation-local",
				thinkingLevel: "off",
				estimatedAccuracy: 0.68,
				estimatedLatencyMs: 420,
				quality: 0.68,
				strengths: { quick_edit: 0.32 },
				estimatedInputUsdPerM: 0,
				estimatedOutputUsdPerM: 0,
				localOnly: true,
				freeModel: true,
			},
			{
				provider: "spettro",
				id: "Velo 3.1 Flash",
				thinkingLevel: "low",
				// Promoted: free model in Spettro with Sonnet-level coding accuracy (0.91) and fast Flash latency!
				estimatedAccuracy: 0.91,
				estimatedLatencyMs: 580,
				quality: 0.91,
				strengths: { quick_edit: 0.16, code_implementation: 0.18 },
				estimatedInputUsdPerM: 0,
				estimatedOutputUsdPerM: 0,
				freeModel: true,
			},
			{
				provider: "claude-subscription",
				id: "claude-haiku-5-5",
				thinkingLevel: "low",
				estimatedAccuracy: 0.85,
				estimatedLatencyMs: 620,
				quality: 0.85,
				strengths: { quick_edit: 0.14, code_implementation: 0.12 },
				estimatedInputUsdPerM: 0.1,
				estimatedOutputUsdPerM: 0.5,
			},
			{
				provider: "codex-subscription",
				id: "gpt-6-luna",
				thinkingLevel: "low",
				estimatedAccuracy: 0.86,
				estimatedLatencyMs: 640,
				quality: 0.86,
				strengths: { code_implementation: 0.14, quick_edit: 0.12 },
				estimatedInputUsdPerM: 0.1,
				estimatedOutputUsdPerM: 0.5,
			},
			{
				provider: "agy-subscription",
				id: "gemini-3.5-flash-lite",
				thinkingLevel: "low",
				estimatedAccuracy: 0.79,
				estimatedLatencyMs: 520,
				quality: 0.79,
				strengths: { quick_edit: 0.14, code_implementation: 0.08 },
				estimatedInputUsdPerM: 0.075,
				estimatedOutputUsdPerM: 0.3,
			},
			{
				provider: "agy-subscription",
				id: "gemini-3.8-flash-low",
				thinkingLevel: "low",
				estimatedAccuracy: 0.84,
				estimatedLatencyMs: 690,
				quality: 0.84,
				strengths: { quick_edit: 0.1, code_implementation: 0.1 },
				estimatedInputUsdPerM: 0.75,
				estimatedOutputUsdPerM: 3.75,
			},
		],
		medium: [
			{
				provider: "spettro",
				id: "Velo 3.1 Flash",
				thinkingLevel: "medium",
				// Promoted top medium candidate: Sonnet-level accuracy (0.91) at $0 cost and sub-700ms latency.
				estimatedAccuracy: 0.91,
				estimatedLatencyMs: 650,
				quality: 0.91,
				strengths: { code_implementation: 0.18, quick_edit: 0.14, deep_architecture: 0.08 },
				estimatedInputUsdPerM: 0,
				estimatedOutputUsdPerM: 0,
				freeModel: true,
			},
			{
				provider: "claude-subscription",
				id: "claude-sonnet-5-5",
				thinkingLevel: "medium",
				estimatedAccuracy: 0.92,
				estimatedLatencyMs: 1150,
				quality: 0.92,
				strengths: { code_implementation: 0.16, deep_architecture: 0.1 },
				estimatedInputUsdPerM: 2.0,
				estimatedOutputUsdPerM: 10.0,
			},
			{
				provider: "agy-subscription",
				id: "gemini-3.8-flash-medium",
				thinkingLevel: "medium",
				estimatedAccuracy: 0.88,
				estimatedLatencyMs: 820,
				quality: 0.88,
				strengths: { code_implementation: 0.14, quick_edit: 0.1 },
				estimatedInputUsdPerM: 0.75,
				estimatedOutputUsdPerM: 3.75,
			},
			{
				provider: "codex-subscription",
				id: "gpt-5.6-terra",
				thinkingLevel: "medium",
				estimatedAccuracy: 0.9,
				estimatedLatencyMs: 1100,
				quality: 0.9,
				strengths: { code_implementation: 0.15 },
				estimatedInputUsdPerM: 2.0,
				estimatedOutputUsdPerM: 12.0,
			},
			{
				provider: "agy-subscription",
				id: "gemini-4-argon-medium",
				thinkingLevel: "medium",
				estimatedAccuracy: 0.92,
				estimatedLatencyMs: 1080,
				quality: 0.92,
				strengths: { code_implementation: 0.14, deep_architecture: 0.12 },
				estimatedInputUsdPerM: 2.0,
				estimatedOutputUsdPerM: 10.0,
			},
			{
				provider: "mistral-vibe",
				id: "mistral-large-4",
				thinkingLevel: "medium",
				estimatedAccuracy: 0.87,
				estimatedLatencyMs: 980,
				quality: 0.87,
				strengths: { code_implementation: 0.11 },
				estimatedInputUsdPerM: 0.68,
				estimatedOutputUsdPerM: 2.09,
			},
		],
		highest: [
			{
				provider: "claude-subscription",
				id: "claude-opus-5-5",
				thinkingLevel: "high",
				estimatedAccuracy: 0.97,
				estimatedLatencyMs: 1850,
				quality: 0.97,
				strengths: { deep_architecture: 0.19, code_implementation: 0.14 },
				estimatedInputUsdPerM: 4.0,
				estimatedOutputUsdPerM: 20.0,
			},
			{
				provider: "codex-subscription",
				id: "gpt-6.1-sol",
				thinkingLevel: "high",
				estimatedAccuracy: 0.96,
				estimatedLatencyMs: 1650,
				quality: 0.96,
				strengths: { code_implementation: 0.18, deep_architecture: 0.15 },
				estimatedInputUsdPerM: 2.0,
				estimatedOutputUsdPerM: 10.0,
			},
			{
				provider: "agy-subscription",
				id: "gemini-4-argon-high",
				thinkingLevel: "high",
				estimatedAccuracy: 0.95,
				estimatedLatencyMs: 1550,
				quality: 0.95,
				strengths: { deep_architecture: 0.16, code_implementation: 0.13 },
				estimatedInputUsdPerM: 2.0,
				estimatedOutputUsdPerM: 10.0,
			},
			{
				provider: "agy-subscription",
				id: "claude-opus-5-5-high",
				thinkingLevel: "high",
				estimatedAccuracy: 0.97,
				estimatedLatencyMs: 1900,
				quality: 0.97,
				strengths: { deep_architecture: 0.18, code_implementation: 0.13 },
				estimatedInputUsdPerM: 4.0,
				estimatedOutputUsdPerM: 20.0,
			},
			{
				provider: "claude-subscription",
				id: "claude-fable-5-1",
				thinkingLevel: "high",
				estimatedAccuracy: 0.98,
				estimatedLatencyMs: 2400,
				quality: 0.98,
				strengths: { deep_architecture: 0.21 },
				estimatedInputUsdPerM: 10.0,
				estimatedOutputUsdPerM: 50.0,
			},
			{
				provider: "codex-subscription",
				id: "gpt-6-astra",
				thinkingLevel: "high",
				estimatedAccuracy: 0.98,
				estimatedLatencyMs: 2300,
				quality: 0.98,
				strengths: { deep_architecture: 0.2, code_implementation: 0.16 },
				estimatedInputUsdPerM: 10.0,
				estimatedOutputUsdPerM: 50.0,
			},
		],
	},
};

function expandHome(path: string): string {
	return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

const VALID_TIERS = new Set<DecisionTier>(["lowest", "medium", "highest"]);
const VALID_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function sanitizeCandidate(raw: unknown): CandidateSpec | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.provider !== "string" || !r.provider.trim() || typeof r.id !== "string" || !r.id.trim()) return undefined;
	const thinkingLevel = typeof r.thinkingLevel === "string" && VALID_LEVELS.has(r.thinkingLevel as ModelThinkingLevel)
		? (r.thinkingLevel as ModelThinkingLevel)
		: "medium";
	const rawAcc = typeof r.estimatedAccuracy === "number" ? r.estimatedAccuracy
		: typeof r.quality === "number" ? r.quality : 0.85;
	const estimatedAccuracy = Number.isFinite(rawAcc) ? Math.min(1, Math.max(0.05, rawAcc)) : 0.85;
	const rawLat = typeof r.estimatedLatencyMs === "number" ? r.estimatedLatencyMs : 1000;
	const estimatedLatencyMs = Number.isFinite(rawLat) && rawLat > 0 ? Math.min(59_000, rawLat) : 1000;
	const estimatedInputUsdPerM = typeof r.estimatedInputUsdPerM === "number" && Number.isFinite(r.estimatedInputUsdPerM) && r.estimatedInputUsdPerM >= 0
		? r.estimatedInputUsdPerM
		: undefined;
	const estimatedOutputUsdPerM = typeof r.estimatedOutputUsdPerM === "number" && Number.isFinite(r.estimatedOutputUsdPerM) && r.estimatedOutputUsdPerM >= 0
		? r.estimatedOutputUsdPerM
		: undefined;
	return {
		provider: r.provider.trim(),
		id: r.id.trim(),
		thinkingLevel,
		estimatedAccuracy,
		estimatedLatencyMs,
		quality: estimatedAccuracy,
		...(r.strengths && typeof r.strengths === "object" && !Array.isArray(r.strengths) ? { strengths: r.strengths as CandidateSpec["strengths"] } : {}),
		...(estimatedInputUsdPerM !== undefined ? { estimatedInputUsdPerM } : {}),
		...(estimatedOutputUsdPerM !== undefined ? { estimatedOutputUsdPerM } : {}),
		...(r.localOnly === true ? { localOnly: true } : {}),
		...(r.freeModel === true ? { freeModel: true } : {}),
	};
}

/**
 * Load the router configuration from disk when present, merging validated fields
 * over `DEFAULT_ROUTER_CONFIG`. Invalid or missing files gracefully fall back to
 * the defaults.
 */
export function loadRouterConfig(
	env: Record<string, string | undefined> = process.env,
	readFile: (path: string) => string | undefined = (p) => {
		try { return readFileSync(p, "utf8"); } catch { return undefined; }
	},
): DecisionRouterConfig {
	const configPath = expandHome(env[CONFIG_ENV]?.trim() || DEFAULT_CONFIG_PATH);
	const localUrl = env[LOCAL_SYSTEMONE_URL_ENV]?.trim() || DEFAULT_LOCAL_SYSTEMONE_URL;
	const base: DecisionRouterConfig = {
		...DEFAULT_ROUTER_CONFIG,
		classifiers: DEFAULT_ROUTER_CONFIG.classifiers.map((c, idx) =>
			idx === 0 && c.kind === "system-one-http" ? { ...c, url: localUrl } : { ...c }),
		subscriptions: Object.fromEntries(
			Object.entries(DEFAULT_ROUTER_CONFIG.subscriptions).map(([k, v]) => [k, { ...v }]),
		),
		tiers: {
			lowest: DEFAULT_ROUTER_CONFIG.tiers.lowest.map((c) => ({ ...c })),
			medium: DEFAULT_ROUTER_CONFIG.tiers.medium.map((c) => ({ ...c })),
			highest: DEFAULT_ROUTER_CONFIG.tiers.highest.map((c) => ({ ...c })),
		},
		weights: { ...DEFAULT_ROUTER_CONFIG.weights },
	};

	const text = readFile(configPath);
	if (!text) return base;
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return base; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return base;
	const root = parsed as Record<string, unknown>;

	if (typeof root.quotaCacheTtlMs === "number" && Number.isFinite(root.quotaCacheTtlMs) && root.quotaCacheTtlMs >= 0) {
		base.quotaCacheTtlMs = root.quotaCacheTtlMs;
	}
	if (root.weights && typeof root.weights === "object" && !Array.isArray(root.weights)) {
		const w = root.weights as Record<string, unknown>;
		for (const k of ["accuracy", "latencyPenalty", "quotaHeadroom", "costPenalty", "cacheStickiness", "localBonus", "freeModelBonus"] as const) {
			if (typeof w[k] === "number" && Number.isFinite(w[k])) base.weights[k] = w[k];
		}
	}
	if (root.tiers && typeof root.tiers === "object" && !Array.isArray(root.tiers)) {
		const t = root.tiers as Record<string, unknown>;
		for (const tier of VALID_TIERS) {
			if (Array.isArray(t[tier])) {
				const list = (t[tier] as unknown[]).map(sanitizeCandidate).filter((c): c is CandidateSpec => c !== undefined);
				if (list.length > 0) base.tiers[tier] = list;
			}
		}
	}
	return base;
}
