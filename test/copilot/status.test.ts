import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerQuotaStatus } from "../../src/domains/copilot/status.ts";
import { parseQuotaHeaders } from "../../src/domains/copilot/usage.ts";

test("footer observes quota without replacing the footer, hides on model switch, and marks stale data", () => {
 const handlers = new Map<string, (...args: any[]) => void>();
 const pi = { on: (event: string, fn: (...args: any[]) => void) => { handlers.set(event, fn); } } as unknown as ExtensionAPI;
 let now = 0;
 const update = registerQuotaStatus(pi, () => now);
 const statuses: Array<string | undefined> = [];
 const ctx = { hasUI: true, model: { provider: "copilot-vscode" }, ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text), theme: { fg: (color: string, text: string) => `${color}:${text}` } } } as unknown as ExtensionContext;
 handlers.get("session_start")!({}, ctx);
 assert.equal(statuses.at(-1), "dim:Copilot usage unavailable");
 update(parseQuotaHeaders(new Headers({ "x-quota-snapshot-premium_models": "ent=100&rem=20" }), now));
 assert.ok(statuses.at(-1)?.startsWith("warning:Copilot [########--]"));
 now = 6 * 60 * 1000;
 handlers.get("agent_end")!({}, ctx);
 assert.ok(statuses.at(-1)?.includes("stale"));
 ctx.model = { provider: "openai" } as never;
 handlers.get("model_select")!({}, ctx); assert.equal(statuses.at(-1), undefined);
 ctx.model = { provider: "copilot-vscode" } as never;
 handlers.get("model_select")!({}, ctx); assert.ok(statuses.at(-1)?.includes("stale"));
 handlers.get("session_shutdown")!({}, ctx);
 const count = statuses.length; update(undefined); assert.equal(statuses.length, count);
});

test("noninteractive sessions do not call UI methods", () => {
 const handlers = new Map<string, (...args: any[]) => void>();
 const update = registerQuotaStatus({ on: (e: string, fn: (...args: any[]) => void) => handlers.set(e, fn) } as unknown as ExtensionAPI);
 handlers.get("session_start")!({}, { hasUI: false });
 update(undefined);
});
