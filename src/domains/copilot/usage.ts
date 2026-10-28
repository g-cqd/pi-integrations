export interface CopilotQuota {
 kind: "premium_models" | "premium_interactions" | "chat";
 entitlement: number;
 remaining: number;
 used: number;
 percentRemaining: number;
 unlimited: boolean;
 overage: number;
 overageEnabled: boolean;
 reset?: string;
 fetchedAt: number;
}

/** Source-derived VS Code quota headers; no guessed plan allowance or local debit. */
export function parseQuotaHeaders(headers: Headers, now: number): CopilotQuota | undefined {
 for (const kind of ["premium_models", "premium_interactions", "chat"] as const) {
  const value = headers.get(`x-quota-snapshot-${kind}`);
  if (value === null) continue;
  if (value.length > 4096) return undefined;
  const p = new URLSearchParams(value);
  const number = (key: string, fallback?: number) => {
   const s = p.get(key);
   return s === null ? fallback : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  };
  const entitlement = number("ent"), percentRemaining = number("rem"), overage = number("ov", 0)!;
  const permission = p.get("ovPerm"), reset = p.get("rst") ?? undefined;
  if (entitlement === undefined || !Number.isFinite(entitlement) || (entitlement < 0 && entitlement !== -1) ||
   percentRemaining === undefined || !Number.isFinite(percentRemaining) || percentRemaining < 0 || percentRemaining > 100 ||
   !Number.isFinite(overage) || overage < 0 || (permission !== null && permission !== "true" && permission !== "false") ||
   (reset !== undefined && (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(reset) || !Number.isFinite(Date.parse(reset))))) return undefined;
  const unlimited = entitlement === -1;
  const remaining = unlimited ? 0 : entitlement * (percentRemaining / 100);
  return { kind, entitlement, percentRemaining, remaining, used: unlimited ? 0 : Math.max(0, entitlement - remaining), unlimited,
   overage, overageEnabled: permission === "true", ...(reset ? { reset } : {}), fetchedAt: now };
 }
 return undefined;
}

export function formatQuota(quota: CopilotQuota | undefined): { text: string; color: "success" | "warning" | "error" | "dim" } {
 if (!quota) return { text: "Copilot usage unavailable", color: "dim" };
 if (quota.unlimited) return { text: "Copilot unlimited", color: "success" };
 const usedFraction = 1 - quota.percentRemaining / 100;
 const filled = Math.floor(usedFraction * 10 + 1e-9);
 const bar = "#".repeat(filled) + "-".repeat(10 - filled);
 const unit = quota.kind === "premium_interactions" ? " requests" : quota.kind === "chat" ? " chat" : "";
 const n = (value: number) => Number(value.toFixed(1)).toString();
 const overage = quota.overageEnabled || quota.overage > 0 ? ` · overage ${n(quota.overage)} ${quota.overageEnabled ? "enabled" : "disabled"}` : "";
 return { text: `Copilot [${bar}] ~${n(quota.used)}/${n(quota.entitlement)}${unit} used · ~${n(quota.remaining)} left${overage}`,
  color: quota.percentRemaining <= 10 ? "error" : quota.percentRemaining <= 25 ? "warning" : "success" };
}
