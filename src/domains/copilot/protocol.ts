import { browserUrl } from "../../shared/index.ts";

// Source inspection, not live measurement. See docs/domains/copilot.md for the
// pinned VS Code / Copilot Chat revisions and the limits of identity parity.
export const CLIENT_ID = "01ab8ac9400c4e429b23";
export const DEFAULT_API_URL = "https://api.githubcopilot.com";
export const EDITOR_VERSION = "1.115.0";
export const PLUGIN_VERSION = "0.44.0";
export const USER_AGENT = `GitHubCopilotChat/${PLUGIN_VERSION}`;

/** Never forward credentials to arbitrary origins supplied by a token/catalog. */
export function copilotApiUrl(value: unknown): string {
	const url = new URL(browserUrl(value));
	if ((url.hostname !== "githubcopilot.com" && !url.hostname.endsWith(".githubcopilot.com")) ||
		url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Untrusted Copilot API endpoint.");
	return url.origin;
}

export interface InstallationIdentity { machineId: string; deviceId: string }
export function clientHeaders(identity: InstallationIdentity, sessionId: string): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"Editor-Version": `vscode/${EDITOR_VERSION}`,
		"Editor-Plugin-Version": `copilot-chat/${PLUGIN_VERSION}`,
		"Copilot-Integration-Id": "vscode-chat",
		"VScode-MachineId": identity.machineId,
		"Editor-Device-Id": identity.deviceId,
		"VScode-SessionId": sessionId,
		"X-GitHub-Api-Version": "2025-10-01",
	};
}
