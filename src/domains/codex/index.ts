import { getModels, openAICodexResponsesApi, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexProvider, PROVIDER_ID } from "./provider.ts";

export default function codex(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, createCodexProvider({
		models: getModels("openai-codex"),
		streamSimple: (model, context, options) =>
			openAICodexResponsesApi().streamSimple(model as Model<"openai-codex-responses">, context, options),
	}));
}
