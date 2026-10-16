/**
 * Experimental Claude OAuth adapter for Pi.
 * Pi owns credential persistence, model metadata, and Anthropic streaming.
 */
import { anthropicMessagesApi, getModels, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProviderConfig, PROVIDER_ID } from "./provider.ts";

export default function claudeOAuth(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, createProviderConfig({
		models: getModels("anthropic"),
		streamSimple: (model, context, options) =>
			anthropicMessagesApi().streamSimple(model as Model<"anthropic-messages">, context, options),
	}));
}
