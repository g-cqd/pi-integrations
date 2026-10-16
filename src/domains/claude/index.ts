/**
 * Experimental Claude OAuth adapter for Pi.
 * Pi owns credential persistence, model metadata, and Anthropic streaming.
 */
import { anthropicMessagesApi, getModels, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subscriptionGateStreamSimple } from "./gate.ts";
import { createProviderConfig, PROVIDER_ID } from "./provider.ts";

export default function claudeOAuth(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, createProviderConfig({
		models: getModels("anthropic"),
		// Subscription inference is gated on prompt content (see gate.ts):
		// the canonical identity line must be the only system block, and the
		// harness's real prompt must ride in user messages. Client-identity
		// headers are applied by Pi's Anthropic implementation for sk-ant-oat keys.
		streamSimple: subscriptionGateStreamSimple((model, context, options) =>
			anthropicMessagesApi().streamSimple(model as Model<"anthropic-messages">, context, options)),
	}));
}
