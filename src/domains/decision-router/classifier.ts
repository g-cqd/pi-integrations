/**
 * Decision-model classification and multi-objective candidate scoring.
 *
 * Stage 1 (Semantic Decision):
 *   A System One decision model (`vllm-d3-lite`, `Laya`, or `jev-latest`)
 *   evaluates the prompt in a single forward pass with zero generated tokens:
 *     - `tier`: `lowest` | `medium` | `highest`
 *     - `task_profile`: `quick_edit` | `code_implementation` | `deep_architecture`
 *     - `local_ok`: boolean (`noul` on the wire) — whether a small 3B local model suffices
 *   When no classifier server is reachable, `heuristicClassifyPrompt` provides
 *   an instant, deterministic fallback.
 *
 * Stage 2 (Multi-Objective Utility Scorer):
 *   Given the chosen tier, task profile, `estimatedAccuracy`, `estimatedLatencyMs`,
 *   live subscription quota snapshots, catalog pricing, free-model promotion
 *   (e.g. Spettro `Velo 3.1 Flash` and on-device Apple Foundation Models), and
 *   prompt-cache stickiness, `selectBestCandidate` picks the highest-utility
 *   available model and automatically escalates or degrades across tiers if
 *   every candidate in the target tier is exhausted.
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { requestText, type FetchImplementation } from "../../shared/index.ts";
import type {
	CandidateSpec, ClassifierEndpointSpec, DecisionRouterConfig, DecisionTier, TaskProfile,
} from "./config.ts";
import type { ProviderQuotaSnapshot } from "./quota.ts";

export interface PromptClassification {
	tier: DecisionTier;
	tierConfidence: number;
	taskProfile: TaskProfile;
	localEligibleProbability: number;
	source: string;
}

export interface ModelLookup {
	find(provider: string, id: string): Model<Api> | undefined;
	findOfType?(type: "classifier", provider: string, id: string): unknown;
	classify?(
		model: unknown,
		context: { state: Record<string, unknown>; questions: Record<string, unknown> },
		options?: { signal?: AbortSignal },
	): Promise<{ stopReason?: string; answers?: Record<string, unknown> }>;
}

const HARD_SIGNALS = /\b(lock[- ]?free|concurrency|race condition|deadlock|aba\b|miri|register allocat|miscompil|formal verif|linearizab|proof|tla\+|zero[- ]?knowledge|cryptograph|memory corruption|use[- ]after[- ]free|kernel panic|distributed consensus|raft|paxos|compiler|security audit|threat model|bisect|root[- ]?cause|multi[- ]module|architecture)\b/i;
const TRIVIAL_SIGNALS = /\b(typo|rename|formatting|indent|comment|readme|changelog|version bump|what is|hello|ping|thank|one[- ]line|spelling)\b/i;
const CODE_SIGNALS = /\b(implement|add|flag|endpoint|test|refactor|function|class|module|parse|cli|bug|handler|schema)\b/i;
const NON_LOCAL_LOOKUP_SIGNALS = /\b(find|search|look\s*up|latest|current|today|todaz|weather|forecast|price|pricing|subscription|docs|documentation|investigate|compare)\b/i;

/** Deterministic fallback when no local or remote System One classifier is reachable. */
export function heuristicClassifyPrompt(prompt: string): PromptClassification {
	const text = prompt.trim();
	const length = text.length;
	const needsLookupOrLiveInfo = NON_LOCAL_LOOKUP_SIGNALS.test(text);

	if (HARD_SIGNALS.test(text) || length > 3500) {
		return {
			tier: "highest",
			tierConfidence: 0.78,
			taskProfile: "deep_architecture",
			localEligibleProbability: 0.05,
			source: "heuristic",
		};
	}
	if (length < 180 && TRIVIAL_SIGNALS.test(text) && !CODE_SIGNALS.test(text)) {
		return {
			tier: "lowest",
			tierConfidence: 0.82,
			taskProfile: "quick_edit",
			localEligibleProbability: needsLookupOrLiveInfo ? 0.15 : 0.88,
			source: "heuristic",
		};
	}
	if (length < 90 && !CODE_SIGNALS.test(text)) {
		return {
			tier: "lowest",
			tierConfidence: 0.65,
			taskProfile: "quick_edit",
			localEligibleProbability: needsLookupOrLiveInfo ? 0.15 : 0.75,
			source: "heuristic",
		};
	}
	return {
		tier: "medium",
		tierConfidence: 0.7,
		taskProfile: "code_implementation",
		localEligibleProbability: 0.25,
		source: "heuristic",
	};
}

const QUESTIONS_PI = {
	tier: {
		type: "choice",
		instructions: "Which thinking tier best matches the complexity of the software engineering request in `prompt`?",
		criteria: {
			lowest: "Trivial edits, typos, renames, formatting, or simple factual questions",
			medium: "Standard feature implementation, unit tests, moderate bug fixes, or single-module refactoring",
			highest: "Hard concurrency, compiler internals, subtle architecture, security audits, or formal verification",
		},
	},
	task_profile: {
		type: "choice",
		instructions: "What kind of engineering work is `prompt` primarily asking for?",
		criteria: {
			quick_edit: "Small localized text or code edit, rename, or formatting",
			code_implementation: "Writing new code, endpoints, CLI flags, or unit tests",
			deep_architecture: "Complex algorithms, systems architecture, concurrency, or root-cause debugging",
		},
	},
	local_ok: {
		type: "bool",
		instructions: "Can a small on-device 3B model handle `prompt` without deep multi-step reasoning?",
		criteria: {
			true: "Yes, it is simple and self-contained",
			false: "No, it needs a larger frontier coding model",
		},
	},
} as const;

const QUESTIONS_WIRE = {
	tier: QUESTIONS_PI.tier,
	task_profile: QUESTIONS_PI.task_profile,
	local_ok: {
		type: "noul",
		instructions: QUESTIONS_PI.local_ok.instructions,
		criteria: QUESTIONS_PI.local_ok.criteria,
	},
} as const;

function parseAnswers(answers: Record<string, unknown> | undefined, source: string): PromptClassification | undefined {
	if (!answers || typeof answers !== "object") return undefined;
	const tierAns = answers.tier as { choice?: unknown; confidence?: unknown } | undefined;
	const profAns = answers.task_profile as { choice?: unknown } | undefined;
	const localAns = answers.local_ok as { probability?: unknown; noul?: unknown } | undefined;

	const tier = tierAns?.choice === "lowest" || tierAns?.choice === "medium" || tierAns?.choice === "highest"
		? tierAns.choice
		: undefined;
	if (!tier) return undefined;

	const taskProfile: TaskProfile = profAns?.choice === "quick_edit" || profAns?.choice === "code_implementation" || profAns?.choice === "deep_architecture"
		? profAns.choice
		: tier === "lowest" ? "quick_edit" : tier === "highest" ? "deep_architecture" : "code_implementation";

	const tierConfidence = typeof tierAns?.confidence === "number" && Number.isFinite(tierAns.confidence)
		? Math.min(1, Math.max(0, tierAns.confidence))
		: 0.5;
	const rawLocal = typeof localAns?.probability === "number" ? localAns.probability
		: typeof localAns?.noul === "number" ? localAns.noul : undefined;
	const localEligibleProbability = typeof rawLocal === "number" && Number.isFinite(rawLocal)
		? Math.min(1, Math.max(0, rawLocal))
		: tier === "lowest" ? 0.7 : 0.1;

	return { tier, tierConfidence, taskProfile, localEligibleProbability, source };
}

async function classifyViaSystemOneHttp(
	spec: ClassifierEndpointSpec,
	prompt: string,
	fetchImpl?: FetchImplementation,
	signal?: AbortSignal,
): Promise<PromptClassification | undefined> {
	if (!spec.url) return undefined;
	const timeout = AbortSignal.timeout(spec.timeoutMs ?? 1500);
	const reqSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const { response, text } = await requestText(spec.url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			...(spec.model ? { model: spec.model } : {}),
			state: { prompt: prompt.slice(0, 8000) },
			questions: QUESTIONS_WIRE,
		}),
	}, { fetchImpl, signal: reqSignal });
	if (!response.ok) return undefined;
	const parsed = JSON.parse(text) as { answers?: Record<string, unknown> };
	return parseAnswers(parsed?.answers, spec.name);
}

async function classifyViaPiRegistry(
	spec: ClassifierEndpointSpec,
	prompt: string,
	registry: ModelLookup,
	signal?: AbortSignal,
): Promise<PromptClassification | undefined> {
	if (!spec.provider || !spec.id || !registry.findOfType || !registry.classify) return undefined;
	const classifier = registry.findOfType("classifier", spec.provider, spec.id);
	if (!classifier) return undefined;
	const timeout = AbortSignal.timeout(spec.timeoutMs ?? 1500);
	const reqSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const result = await registry.classify(
		classifier,
		{ state: { prompt: prompt.slice(0, 8000) }, questions: QUESTIONS_PI as unknown as Record<string, unknown> },
		{ signal: reqSignal },
	);
	if (result?.stopReason !== "stop") return undefined;
	return parseAnswers(result.answers, spec.name);
}

/**
 * Run the configured chain of System One decision models (`vllm-d3-lite`,
 * `Laya`, `Jev`, etc.) and fall back to the deterministic heuristic classifier
 * if none is reachable.
 */
export async function classifyPrompt(params: {
	prompt: string;
	config: DecisionRouterConfig;
	registry: ModelLookup;
	fetchImpl?: FetchImplementation;
	signal?: AbortSignal;
}): Promise<PromptClassification> {
	const trimmed = params.prompt.trim();
	if (!trimmed) return heuristicClassifyPrompt("");

	for (const spec of params.config.classifiers) {
		params.signal?.throwIfAborted();
		try {
			const res = spec.kind === "system-one-http"
				? await classifyViaSystemOneHttp(spec, trimmed, params.fetchImpl, params.signal)
				: await classifyViaPiRegistry(spec, trimmed, params.registry, params.signal);
			if (res) return res;
		} catch {
			params.signal?.throwIfAborted();
		}
	}
	return heuristicClassifyPrompt(trimmed);
}

export interface ScoredCandidate {
	candidate: CandidateSpec;
	model: Model<Api>;
	score: number;
	tier: DecisionTier;
	estimatedAccuracy: number;
	estimatedLatencyMs: number;
	quotaRemaining: number;
	costUsdPerM: number;
}

function modelInputCostPerM(model: Model<Api>, candidate: CandidateSpec): number {
	const catalogCost = (model as { cost?: { input?: unknown } }).cost?.input;
	if (typeof catalogCost === "number" && Number.isFinite(catalogCost) && catalogCost > 0) return catalogCost;
	return candidate.estimatedInputUsdPerM ?? 0;
}

/**
 * Multi-objective utility scorer over a tier's candidate models.
 *
 * Weighs:
 *   1. `estimatedAccuracy` + task-profile specialization bonus
 *   2. `estimatedLatencyMs` (normalized against a 2,500 ms ceiling)
 *   3. `quotaRemaining` (with nonlinear conservation below 20%)
 *   4. `costUsdPerM` + `freeModel` bonus (promoting free high-accuracy models like Spettro `Velo 3.1 Flash`)
 *   5. `localOnly` bonus when the decision model reports high `local_ok` probability (promoting Apple Foundation Models for quick local tasks)
 *   6. Prompt-cache stickiness when staying on the previous turn's model
 */
export function selectBestCandidate(params: {
	targetTier: DecisionTier;
	classification?: PromptClassification;
	config: DecisionRouterConfig;
	quotas: Record<string, ProviderQuotaSnapshot>;
	registry: ModelLookup;
	previousModel?: { provider: string; id: string };
	estimatedPromptTokens?: number;
}): ScoredCandidate {
	const { targetTier, classification, config, quotas, registry, previousModel } = params;
	const promptTokens = params.estimatedPromptTokens ?? 500;
	const w = config.weights;

	const tierOrder: DecisionTier[] = targetTier === "lowest"
		? ["lowest", "medium", "highest"]
		: targetTier === "medium"
			? ["medium", "highest", "lowest"]
			: ["highest", "medium", "lowest"];

	for (const tier of tierOrder) {
		const scored: ScoredCandidate[] = [];
		for (const candidate of config.tiers[tier] ?? []) {
			const model = registry.find(candidate.provider, candidate.id);
			if (!model) continue;

			const ctxWindow = typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : 128_000;
			if (promptTokens > ctxWindow * 0.85) continue;

			const quota = quotas[candidate.provider];
			if (quota?.exhausted) continue;
			if (quota?.unavailableModels?.has(candidate.id)) continue;

			const sub = config.subscriptions[candidate.provider];
			const estimatedAccuracy = candidate.estimatedAccuracy ?? sub?.estimatedAccuracy ?? 0.85;
			const estimatedLatencyMs = candidate.estimatedLatencyMs ?? sub?.estimatedLatencyMs ?? 1000;

			const quotaRemaining = quota ? quota.effectiveRemaining : 1;
			const costUsdPerM = modelInputCostPerM(model, candidate);
			const normCost = Math.min(1, costUsdPerM / 10);
			const normLatency = Math.min(1, estimatedLatencyMs / 2500);

			const taskProfile = classification?.taskProfile ?? (tier === "lowest" ? "quick_edit" : tier === "highest" ? "deep_architecture" : "code_implementation");
			const profileBonus = candidate.strengths?.[taskProfile] ?? 0;

			const stickyBonus = previousModel && previousModel.provider === candidate.provider && previousModel.id === candidate.id
				? w.cacheStickiness
				: 0;

			// Local 3B models get a strong bonus when the classifier says local_ok is high,
			// and a penalty when the prompt is too long or not local-eligible.
			let localAdjustment = 0;
			if (candidate.localOnly) {
				const localProb = classification?.localEligibleProbability ?? (tier === "lowest" && promptTokens < 1200 ? 0.75 : 0.15);
				localAdjustment = localProb >= 0.65 && promptTokens < 1500
					? w.localBonus * localProb
					: -0.35;
			}

			// Free cloud models (e.g. Spettro Velo 3.1 Flash) get a promotion bonus
			// because they consume zero paid quota while delivering high accuracy.
			const freeBonus = candidate.freeModel && !candidate.localOnly ? w.freeModelBonus : 0;

			// Nonlinear quota conservation: penalize providers below 20% remaining so
			// scarce weekly/5h allowance is preserved when another subscription is fresh.
			const quotaFactor = quotaRemaining < 0.2 ? quotaRemaining * 0.5 : quotaRemaining;

			const score =
				w.accuracy * (estimatedAccuracy + profileBonus) -
				w.latencyPenalty * normLatency +
				w.quotaHeadroom * quotaFactor -
				w.costPenalty * normCost +
				stickyBonus +
				localAdjustment +
				freeBonus;

			scored.push({
				candidate,
				model,
				score,
				tier,
				estimatedAccuracy,
				estimatedLatencyMs,
				quotaRemaining,
				costUsdPerM,
			});
		}

		if (scored.length > 0) {
			scored.sort((a, b) => b.score - a.score);
			return scored[0]!;
		}
	}

	throw new Error(
		"Decision router found no available candidate model with active credentials and remaining quota across any tier. " +
		"Sign in to at least one provider (/login) or check your subscription limits.",
	);
}

/** Map Pi's virtual thinking level selection onto either a fixed tier or `"auto"`. */
export function resolveRequestedMode(thinkingLevel: ModelThinkingLevel): DecisionTier | "auto" {
	switch (thinkingLevel) {
		case "off":
		case "minimal":
		case "low":
			return "lowest";
		case "medium":
			return "medium";
		case "high":
			return "highest";
		case "xhigh":
		default:
			return "auto";
	}
}
