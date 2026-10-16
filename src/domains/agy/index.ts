import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgyProvider, PROVIDER_ID } from "./provider.ts";

export default function agy(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, createAgyProvider({ env: process.env }));
}
