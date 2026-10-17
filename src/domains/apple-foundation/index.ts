import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAppleFoundationProvider, isSupportedAppleHost, PROVIDER_ID } from "./provider.ts";

export default function appleFoundation(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, createAppleFoundationProvider({ autoEnable: isSupportedAppleHost() }));
}
