import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDecisionVirtualModels } from "./router.ts";

export default function decisionRouter(pi: ExtensionAPI) {
	for (const model of createDecisionVirtualModels()) {
		pi.registerVirtualModel(model);
	}
}
