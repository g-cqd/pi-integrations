/**
 * Synthetic Decision Router virtual models (`decision-router/router`,
 * `decision-router/auto`, `decision-router/lowest`, `decision-router/medium`,
 * `decision-router/highest`).
 *
 * How thinking levels work on `decision-router/router`:
 *   - `low`    -> Lowest thinking tier (Apple Foundation Models local 3B, Gemini Flash Lite, Haiku 5.5, GPT-6 Luna)
 *   - `medium` -> Medium thinking tier (Gemini 3.8 Flash Medium, Claude Sonnet 5.5, GPT-5.6 Terra, Mistral Large 4)
 *   - `high`   -> Highest thinking tier (Claude Opus 5.5, GPT-6.1 Sol, Gemini 4 Argon High, Claude Fable 5.1)
 *   - `xhigh`  -> Auto (Decision Model `vllm-d3-lite` / `Laya` / `Jev` classifies the prompt into a tier + task profile,
 *                 and the utility scorer combines that with live subscription quotas and catalog pricing)
 *
 * Also registers explicit `decision-router/auto`, `decision-router/lowest`,
 * `decision-router/medium`, and `decision-router/highest` virtual models so
 * users can pick `--model decision-router/auto` or `--model decision-router/lowest`
 * directly without changing `/thinking`.
 */
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI, ExtensionContext, ExtensionVirtualModel, ModelRoute, ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import type { FetchImplementation } from "../../shared/index.ts";
import { classifyPrompt, resolveRequestedMode, selectBestCandidate, type ModelLookup } from "./classifier.ts";
import { loadRouterConfig, type DecisionRouterConfig, type DecisionTier, type TaskProfile } from "./config.ts";
import { createQuotaTracker, type ReadAuthStore } from "./quota.ts";

export const ROUTER_PROVIDER_ID = "decision-router";
export const ROUTER_MODEL_ID = "router";
export const AUTO_MODEL_ID = "auto";

export interface DecisionRouterState {
	chosenProvider: string;
	chosenModelId: string;
	chosenThinkingLevel: ModelThinkingLevel;
	tier: DecisionTier;
	taskProfile?: TaskProfile;
	estimatedAccuracy: number;
	estimatedLatencyMs: number;
	classifierSource: string;
}

export interface DecisionRouterDependencies {
	env?: Record<string, string | undefined>;
	fetchImpl?: FetchImplementation;
	readAuthStore?: ReadAuthStore;
	readConfigFile?: (path: string) => string | undefined;
	now?: () => number;
}

function lastUserPrompt(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "user") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((b): b is { type: "text"; text: string } => Boolean(b && typeof b === "object" && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string"))
				.map((b) => b.text)
				.join("\n");
		}
	}
	return "";
}

function estimateConversationTokens(messages: readonly Message[]): number {
	let chars = 0;
	for (const m of messages) {
		if (!m) continue;
		const c = (m as { content?: unknown }).content;
		if (typeof c === "string") chars += c.length;
		else if (Array.isArray(c)) {
			for (const b of c) {
				if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
					chars += ((b as { text: string }).text).length;
				}
			}
		}
	}
	return Math.max(100, Math.ceil(chars / 4));
}

function isQuotaOrRateLimitFailure(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return /usage limit|rate.?limit|quota|429|out of extra usage|subscription sharing|not supported when using codex/i.test(errorMessage);
}

function allCandidateProviders(config: DecisionRouterConfig): string[] {
	const set = new Set<string>();
	for (const list of Object.values(config.tiers)) {
		for (const c of list) set.add(c.provider);
	}
	return [...set];
}

export function createDecisionVirtualModels(deps: DecisionRouterDependencies = {}): Array<ExtensionVirtualModel<DecisionRouterState>> {
	const quotaTracker = createQuotaTracker({
		fetchImpl: deps.fetchImpl,
		readAuthStore: deps.readAuthStore,
		now: deps.now,
	});

	function buildRoute(forcedMode?: DecisionTier | "auto") {
		return async (
			request: ModelRouteRequest<DecisionRouterState>,
			ctx: ExtensionContext,
		): Promise<ModelRoute<DecisionRouterState>> => {
			request.signal?.throwIfAborted();
			const config = loadRouterConfig(deps.env, deps.readConfigFile);
			const registry = ctx.modelRegistry as unknown as ModelLookup;

			// If this is a retry after a quota/rate-limit failure on the previous model,
			// mark that provider/model exhausted and re-route to the next best survivor!
			if (request.reason === "retry" && request.failed) {
				const errText = request.failed.message?.errorMessage;
				if (isQuotaOrRateLimitFailure(errText)) {
					const isModelSpecific = /not supported when using codex|requested entity was not found/i.test(errText ?? "");
					quotaTracker.markExhausted(
						request.failed.model.provider,
						isModelSpecific ? request.failed.model.id : undefined,
					);
				} else {
					return {
						model: request.failed.model,
						thinkingLevel: request.failed.thinkingLevel ?? "medium",
						state: request.state,
					};
				}
			}

			// Tool continuations within a turn stay on the model that started the turn
			// so prompt caches and thought signatures stay valid.
			if (request.reason === "continuation" && request.previous) {
				return {
					model: request.previous.model,
					thinkingLevel: request.previous.thinkingLevel ?? "medium",
					state: request.state,
				};
			}

			const estimatedPromptTokens = estimateConversationTokens(request.messages);

			// Direct requests (e.g. compaction summaries) route to the best lowest-tier
			// model that fits the conversation context window.
			if (request.reason === "direct") {
				const quotas = await quotaTracker.getQuotas(allCandidateProviders(config), config.quotaCacheTtlMs, request.signal);
				const chosen = selectBestCandidate({
					targetTier: "lowest",
					config,
					quotas,
					registry,
					estimatedPromptTokens,
				});
				return { model: chosen.model, thinkingLevel: chosen.candidate.thinkingLevel };
			}

			const mode = forcedMode ?? resolveRequestedMode(request.thinkingLevel);
			const prompt = lastUserPrompt(request.messages);

			const [quotas, classification] = await Promise.all([
				quotaTracker.getQuotas(allCandidateProviders(config), config.quotaCacheTtlMs, request.signal),
				mode === "auto"
					? classifyPrompt({ prompt, config, registry, fetchImpl: deps.fetchImpl, signal: request.signal })
					: Promise.resolve(undefined),
			]);

			const targetTier: DecisionTier = mode === "auto" ? (classification?.tier ?? "medium") : mode;
			const chosen = selectBestCandidate({
				targetTier,
				classification,
				config,
				quotas,
				registry,
				previousModel: request.previous ? { provider: request.previous.model.provider, id: request.previous.model.id } : undefined,
				estimatedPromptTokens,
			});

			const nextState: DecisionRouterState = {
				chosenProvider: chosen.candidate.provider,
				chosenModelId: chosen.candidate.id,
				chosenThinkingLevel: chosen.candidate.thinkingLevel,
				tier: chosen.tier,
				taskProfile: classification?.taskProfile,
				estimatedAccuracy: chosen.estimatedAccuracy,
				estimatedLatencyMs: chosen.estimatedLatencyMs,
				classifierSource: classification?.source ?? `fixed:${targetTier}`,
			};

			return {
				model: chosen.model,
				thinkingLevel: chosen.candidate.thinkingLevel,
				state: nextState,
			};
		};
	}

	return [
		{
			provider: ROUTER_PROVIDER_ID,
			id: ROUTER_MODEL_ID,
			name: "Decision Router (low=Lowest · medium=Medium · high=Highest · xhigh=Auto)",
			thinkingLevels: ["low", "medium", "high", "xhigh"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			route: buildRoute(undefined),
		},
		{
			provider: ROUTER_PROVIDER_ID,
			id: AUTO_MODEL_ID,
			name: "Decision Router: Auto (Decision Model + Quota + Price)",
			thinkingLevels: ["low", "medium", "high", "xhigh"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			route: buildRoute("auto"),
		},
		{
			provider: ROUTER_PROVIDER_ID,
			id: "lowest",
			name: "Decision Router: Lowest Tier (Apple FM Local · Flash Lite · Haiku · Luna)",
			thinkingLevels: ["low"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			route: buildRoute("lowest"),
		},
		{
			provider: ROUTER_PROVIDER_ID,
			id: "medium",
			name: "Decision Router: Medium Tier (Flash · Sonnet · Terra · Argon Medium)",
			thinkingLevels: ["medium"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			route: buildRoute("medium"),
		},
		{
			provider: ROUTER_PROVIDER_ID,
			id: "highest",
			name: "Decision Router: Highest Tier (Opus · Sol · Argon High · Fable · Astra)",
			thinkingLevels: ["high", "xhigh"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			route: buildRoute("highest"),
		},
	];
}
