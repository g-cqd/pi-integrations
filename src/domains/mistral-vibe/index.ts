import { getModels, mistralConversationsApi, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMistralVibeProvider, PROVIDER_ID } from "./provider.ts";

export default function mistralVibe(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, createMistralVibeProvider({
		models: getModels("mistral"),
		streamSimple: (model, context, options) =>
			mistralConversationsApi().streamSimple(model as Model<"mistral-conversations">, context, options),
	}));
}
