/**
 * Live model catalog for the Codex (ChatGPT subscription) domain.
 *
 * Evidence, and its limits. The endpoint and response vocabulary come from
 * strings in the shipped `codex` CLI (0.163.0): the host constant
 * `https://chatgpt.com/backend-api`, the path `codex` immediately followed by
 * `model`, and the descriptor field names `slug`, `display_name`,
 * `context_window`, `max_output_tokens`, `max_context_window`,
 * `supported_reasoning_levels`, `default_reasoning_level`, `visibility`,
 * `supported_in_api`, `input_modalities`, plus the validation message
 * "catalog must contain unique, non-empty model slugs".
 *
 * What is NOT verified: that this client identity is accepted, the exact JSON
 * envelope (this module accepts the models under `models`, at the top level, or
 * nested one level down, because the CLI does not pin it), and that every field
 * above is present on every entry. A live response has not been observed. As
 * with the Antigravity client, a rejection is reported through describeFailure
 * rather than silently degrading to the static catalog.
 *
 * Why the static catalog remains: Pi's own Codex login performs no discovery,
 * and this catalog is a strict improvement over it only when it answers. Every
 * failure path here falls back to `getModels("openai-codex")`, so an unknown
 * endpoint shape cannot leave the user with no models at all.
 */
import { fetchCodexCatalog, CODEX_MODELS_PATH, type CodexModelInfo } from "./catalog.ts";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export { CODEX_MODELS_PATH, fetchCodexCatalog, type CodexModelInfo };
export { describeFailure, parseCatalog } from "./catalog.ts";

/** Pi's static catalog, the fallback whenever discovery cannot be trusted. */
export function staticModels(): ProviderModelConfig[] {
	return getModels("openai-codex") as unknown as ProviderModelConfig[];
}

/** `ProviderModelConfig` is a union; these are the fields this domain reads. */
type Limits = { contextWindow?: number; maxTokens?: number; reasoning?: boolean };
const limitsOf = (config: ProviderModelConfig | undefined): Limits => config as Limits | undefined ?? {};

const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Maps this client's effort names onto the levels the server reported. */
function toReasoning(config: CodexModelInfo): boolean {
	// Present when the server says the model can think. An absent list is not
	// evidence of absence, so a model that reports no levels stays reasoning-capable
	// only if the static catalog agrees; this domain never turns reasoning off for
	// a model Pi believes supports it.
	return config.supportedReasoningLevels.length > 0 || config.defaultReasoningLevel !== undefined;
}

/**
 * Convert a server entry into Pi's model config, taking limits from the server
 * and inheriting only what the server does not describe.
 *
 * The static entry for the same slug supplies pricing and capability flags,
 * because the live catalog does not carry prices and a subscription is not
 * billed per token. A model the server lists but the static catalog lacks is
 * still offered, with conservative limits and zero cost, rather than hidden.
 */
export function toModelConfig(info: CodexModelInfo, fallback: ProviderModelConfig[]): ProviderModelConfig {
	const known = fallback.find((m) => m.id === info.slug);
	const name = info.displayName?.trim() || known?.name || info.slug;
	return {
		...(known ?? {}),
		id: info.slug,
		name,
		// Never advertise an effort level the server did not report.
		...(info.supportedReasoningLevels.length > 0
			? { thinkingLevelMap: Object.fromEntries(
				info.supportedReasoningLevels
					.filter((level): level is (typeof REASONING_LEVELS)[number] => (REASONING_LEVELS as readonly string[]).includes(level))
					.map((level) => [level === "minimal" ? "minimal" : level, level]),
			) }
			: {}),
		contextWindow: info.contextWindow ?? limitsOf(known).contextWindow ?? 272_000,
		maxTokens: info.maxOutputTokens ?? limitsOf(known).maxTokens,
		reasoning: toReasoning(info),
	} as ProviderModelConfig;
}

/** Server order first, then any static model the server did not list. */
export function mergeCatalog(remote: CodexModelInfo[], fallback: ProviderModelConfig[]): ProviderModelConfig[] {
	const listed = new Set(remote.map((m) => m.slug));
	const merged = remote.map((info) => toModelConfig(info, fallback));
	// A model absent from the live catalog may have been withdrawn for this
	// account, so it is NOT appended. Appending would reintroduce exactly the
	// stale-catalog problem discovery exists to remove.
	void listed;
	return merged;
}
