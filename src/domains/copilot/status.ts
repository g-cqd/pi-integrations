import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatQuota, type CopilotQuota } from "./usage.ts";

/** Uses an extension status slot, preserving Pi's footer and other extensions. */
export function registerQuotaStatus(pi: ExtensionAPI, now = Date.now) {
 let context: ExtensionContext | undefined;
 let quota: CopilotQuota | undefined;
 const render = () => {
  if (!context?.hasUI) return;
  if (context.model?.provider !== "copilot-vscode") { context.ui.setStatus("copilot-usage", undefined); return; }
  const display = formatQuota(quota);
  const stale = quota && now() - quota.fetchedAt >= 5 * 60 * 1000;
  context.ui.setStatus("copilot-usage", context.ui.theme.fg(stale ? "dim" : display.color, display.text + (stale ? " (stale)" : "")));
 };
 const observe = (_event: unknown, ctx: ExtensionContext) => { context = ctx; render(); };
 pi.on("session_start", observe);
 pi.on("model_select", observe);
 pi.on("agent_end", observe);
 pi.on("session_shutdown", (_event, ctx) => { if (ctx.hasUI) ctx.ui.setStatus("copilot-usage", undefined); context = undefined; quota = undefined; });
 return (snapshot: CopilotQuota | undefined) => { quota = snapshot; render(); };
}
