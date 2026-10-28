import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { copilotPrice } from "./pricing.ts";
import { record } from "../../shared/index.ts";

export type ChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

export const API_ID = "copilot-vscode-chat";
export const CATALOG_PLACEHOLDER = "copilot-catalog-loading";
export const placeholderModel: ChatModelConfig = {
	id: CATALOG_PLACEHOLDER, name: "Sign in / refresh Copilot model catalog", api: API_ID,
	input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const positive = (value: unknown, fallback: number): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Account catalog only: never auto-enable policies or invent a static entitlement. */
export function parseCatalog(payload: unknown, baseUrl: string): ChatModelConfig[] {
	const data = record(payload).data;
	if (!Array.isArray(data)) throw new Error("Invalid Copilot model catalog.");
	const models: ChatModelConfig[] = [];
	const seen = new Set<string>();
	for (const value of data) {
		const item = object(value);
		const caps = object(item.capabilities), supports = object(caps.supports), limits = object(caps.limits);
		if (typeof item.id !== "string" || !/^[\w.:-]{1,200}$/.test(item.id) || seen.has(item.id) ||
			item.model_picker_enabled !== true || object(item.policy).state === "disabled" ||
			caps.type !== "chat" || supports.tool_calls !== true || supports.streaming !== true) continue;
		const endpoints = Array.isArray(item.supported_endpoints) ? item.supported_endpoints : ["/chat/completions"];
		const api = endpoints.includes("/responses") ? "openai-responses"
			: endpoints.includes("/v1/messages") ? "anthropic-messages"
			: endpoints.includes("/chat/completions") ? "openai-completions" : undefined;
		if (!api) continue;
		seen.add(item.id);
		const reasoningEfforts = Array.isArray(supports.reasoning_effort) ? supports.reasoning_effort : [];
		models.push({
			id: item.id, name: typeof item.name === "string" ? item.name : item.id, api, baseUrl,
			input: supports.vision === true ? ["text", "image"] : ["text"],
			reasoning: supports.thinking === true || supports.adaptive_thinking === true || reasoningEfforts.length > 0,
			contextWindow: positive(limits.max_context_window_tokens, positive(limits.max_prompt_tokens, 8192)),
			maxTokens: positive(limits.max_output_tokens, 4096),
			cost: copilotPrice(item.id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...(api === "openai-completions" ? { compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: reasoningEfforts.length > 0 } } : {}),
			...(api === "anthropic-messages" ? { compat: { forceAdaptiveThinking: supports.adaptive_thinking === true } } : {}),
		});
	}
	return models;
}
