import { openAICompletionsApi, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSpettroProvider, PROVIDER_ID } from "./provider.ts";

export default function spettro(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, createSpettroProvider({
		env: process.env,
		streamSimple: (model, context, options) =>
			openAICompletionsApi().streamSimple(model as Model<"openai-completions">, context, options),
	}));
}
