import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCopilotProvider, PROVIDER_ID } from "./provider.ts";

import { refreshCopilotPrices } from "./pricing.ts";
import { registerQuotaStatus } from "./status.ts";

export default function copilot(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, createCopilotProvider({
		onQuota: registerQuotaStatus(pi),
		refreshPrices: refreshCopilotPrices,
		streamSimple: (model, context, options) => {
			if (model.api === "anthropic-messages") return anthropicMessagesApi().streamSimple(model as Model<"anthropic-messages">, context, options);
			if (model.api === "openai-responses") return openAIResponsesApi().streamSimple(model as Model<"openai-responses">, context, options);
			if (model.api === "openai-completions") return openAICompletionsApi().streamSimple(model as Model<"openai-completions">, context, options);
			throw new Error("Unsupported Copilot model protocol.");
		},
	}));
}
