/**
 * Live subscription quota probes for the decision router.
 *
 * Each subscription domain exposes a live quota endpoint verified during this
 * project's protocol investigations:
 *   - `claude-subscription`: GET `https://api.anthropic.com/api/oauth/usage`
 *     returns `five_hour.utilization` (0-100) and `seven_day.utilization` (0-100).
 *   - `codex-subscription`: GET `https://chatgpt.com/backend-api/codex/usage`
 *     returns `rate_limit.allowed`, `primary_window.used_percent`,
 *     `secondary_window.used_percent`, and `model_usage[slug].available`.
 *   - `agy-subscription`: POST `https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
 *     returns `groups[].buckets[]` with `window` ("5h" | "weekly") and `remainingFraction` (0-1).
 *   - `apple-foundation`: on-device local model -> 100% remaining, never exhausted.
 *
 * Probes are non-fatal, bounded by a short timeout, and cached per provider so
 * routing adds zero network latency on warm turns.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { requestText, validSecret, type FetchImplementation } from "../../shared/index.ts";
import { DEFAULT_BASE_URL as AGY_BASE_URL, USER_AGENT as AGY_USER_AGENT } from "../agy/cloudcode.ts";

export interface ProviderQuotaSnapshot {
	provider: string;
	/** Remaining fraction in [0, 1] for the short (5-hour) window. */
	fiveHourRemaining: number;
	/** Remaining fraction in [0, 1] for the weekly window. */
	weeklyRemaining: number;
	/** Effective bottleneck remaining fraction: `min(fiveHourRemaining, weeklyRemaining)`. */
	effectiveRemaining: number;
	/** True when the subscription is completely out of quota right now. */
	exhausted: boolean;
	/** Per-model availability overrides when the provider reports them (e.g. Codex `gpt-6-astra`). */
	unavailableModels?: ReadonlySet<string>;
	fetchedAt: number;
}

export interface StoredAuthEntry {
	access?: string;
	projectId?: string;
	[key: string]: unknown;
}

export type ReadAuthStore = () => Record<string, StoredAuthEntry>;

export const defaultReadAuthStore: ReadAuthStore = () => {
	const dir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	try {
		const raw = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, StoredAuthEntry>) : {};
	} catch {
		return {};
	}
};

function round6(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return round6(Math.min(1, Math.max(0, value)));
}

export function parseClaudeUsage(body: unknown, now: number): ProviderQuotaSnapshot | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const b = body as Record<string, unknown>;
	const five = b.five_hour && typeof b.five_hour === "object" ? (b.five_hour as Record<string, unknown>) : undefined;
	const week = b.seven_day && typeof b.seven_day === "object" ? (b.seven_day as Record<string, unknown>) : undefined;
	const fiveUsed = typeof five?.utilization === "number" ? five.utilization / 100 : 0;
	const weekUsed = typeof week?.utilization === "number" ? week.utilization / 100 : 0;
	const fiveRem = clamp01(1 - fiveUsed);
	const weekRem = clamp01(1 - weekUsed);
	const locked = Boolean(five?.locked_reason || week?.locked_reason);
	const effective = Math.min(fiveRem, weekRem);
	return {
		provider: "claude-subscription",
		fiveHourRemaining: fiveRem,
		weeklyRemaining: weekRem,
		effectiveRemaining: locked ? 0 : effective,
		exhausted: locked || effective <= 0.005,
		fetchedAt: now,
	};
}

export function parseCodexUsage(body: unknown, now: number): ProviderQuotaSnapshot | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const b = body as Record<string, unknown>;
	const rl = b.rate_limit && typeof b.rate_limit === "object" ? (b.rate_limit as Record<string, unknown>) : undefined;
	if (!rl) return undefined;
	const pWin = rl.primary_window && typeof rl.primary_window === "object" ? (rl.primary_window as Record<string, unknown>) : undefined;
	const sWin = rl.secondary_window && typeof rl.secondary_window === "object" ? (rl.secondary_window as Record<string, unknown>) : undefined;
	const fiveRem = typeof pWin?.used_percent === "number" ? clamp01(1 - pWin.used_percent / 100) : 1;
	const weekRem = typeof sWin?.used_percent === "number" ? clamp01(1 - sWin.used_percent / 100) : 1;
	const blocked = rl.allowed === false || rl.limit_reached === true;
	const effective = blocked ? 0 : Math.min(fiveRem, weekRem);
	const unavailable = new Set<string>();
	// gpt-5.5 is rejected for ChatGPT accounts regardless of quota.
	unavailable.add("gpt-5.5");
	if (b.model_usage && typeof b.model_usage === "object" && !Array.isArray(b.model_usage)) {
		for (const [slug, info] of Object.entries(b.model_usage as Record<string, unknown>)) {
			if (info && typeof info === "object" && (info as { available?: unknown }).available === false) {
				unavailable.add(slug);
			}
		}
	}
	return {
		provider: "codex-subscription",
		fiveHourRemaining: fiveRem,
		weeklyRemaining: weekRem,
		effectiveRemaining: effective,
		exhausted: blocked || effective <= 0.005,
		unavailableModels: unavailable,
		fetchedAt: now,
	};
}

export function parseAgyQuotaSummary(body: unknown, now: number): ProviderQuotaSnapshot | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const b = body as Record<string, unknown>;
	if (!Array.isArray(b.groups)) return undefined;
	let fiveRem = 1;
	let weekRem = 1;
	for (const group of b.groups) {
		const buckets = group && typeof group === "object" ? (group as { buckets?: unknown[] }).buckets : undefined;
		for (const bucket of Array.isArray(buckets) ? buckets : []) {
			if (!bucket || typeof bucket !== "object") continue;
			const bk = bucket as { window?: unknown; remainingFraction?: unknown };
			const rem = typeof bk.remainingFraction === "number" ? clamp01(bk.remainingFraction) : undefined;
			if (rem === undefined) continue;
			if (bk.window === "5h") fiveRem = Math.min(fiveRem, rem);
			else if (bk.window === "weekly") weekRem = Math.min(weekRem, rem);
		}
	}
	const effective = Math.min(fiveRem, weekRem);
	return {
		provider: "agy-subscription",
		fiveHourRemaining: fiveRem,
		weeklyRemaining: weekRem,
		effectiveRemaining: effective,
		exhausted: effective <= 0.005,
		fetchedAt: now,
	};
}

export interface QuotaTrackerOptions {
	fetchImpl?: FetchImplementation;
	readAuthStore?: ReadAuthStore;
	now?: () => number;
	ttlMs?: number;
}

export function createQuotaTracker(opts: QuotaTrackerOptions = {}) {
	const cache = new Map<string, ProviderQuotaSnapshot>();
	const now = opts.now ?? Date.now;
	const readAuth = opts.readAuthStore ?? defaultReadAuthStore;

	async function fetchOne(provider: string, auth: StoredAuthEntry | undefined, signal?: AbortSignal): Promise<ProviderQuotaSnapshot> {
		const ts = now();
		if (provider === "apple-foundation") {
			return { provider, fiveHourRemaining: 1, weeklyRemaining: 1, effectiveRemaining: 1, exhausted: false, fetchedAt: ts };
		}
		const token = auth?.access;
		if (!validSecret(token)) {
			return { provider, fiveHourRemaining: 1, weeklyRemaining: 1, effectiveRemaining: 1, exhausted: false, fetchedAt: ts };
		}
		const timeout = AbortSignal.timeout(2500);
		const reqSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		try {
			if (provider === "claude-subscription") {
				const { response, text } = await requestText("https://api.anthropic.com/api/oauth/usage", {
					method: "GET",
					headers: {
						Authorization: `Bearer ${token}`,
						"anthropic-version": "2023-06-01",
						"anthropic-beta": "oauth-2025-04-20",
						"User-Agent": "claude-cli/2.1.301 (external, cli)",
						Accept: "application/json",
					},
				}, { fetchImpl: opts.fetchImpl, signal: reqSignal });
				if (response.ok) {
					const parsed = parseClaudeUsage(JSON.parse(text), ts);
					if (parsed) return parsed;
				}
			} else if (provider === "codex-subscription") {
				const { response, text } = await requestText("https://chatgpt.com/backend-api/codex/usage", {
					method: "GET",
					headers: {
						Authorization: `Bearer ${token}`,
						"User-Agent": "codex-cli/0.163.0",
						Accept: "application/json",
					},
				}, { fetchImpl: opts.fetchImpl, signal: reqSignal });
				if (response.ok) {
					const parsed = parseCodexUsage(JSON.parse(text), ts);
					if (parsed) return parsed;
				}
			} else if (provider === "agy-subscription") {
				const project = typeof auth?.projectId === "string" && auth.projectId ? auth.projectId : "aicode-consumers";
				const { response, text } = await requestText(`${AGY_BASE_URL}/v1internal:retrieveUserQuotaSummary`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						Accept: "application/json",
						"User-Agent": AGY_USER_AGENT,
					},
					body: JSON.stringify({ project }),
				}, { fetchImpl: opts.fetchImpl, signal: reqSignal });
				if (response.ok) {
					const parsed = parseAgyQuotaSummary(JSON.parse(text), ts);
					if (parsed) return parsed;
				}
			}
		} catch {
			// Quota probe failure is non-fatal: fall back to neutral headroom.
		}
		return { provider, fiveHourRemaining: 1, weeklyRemaining: 1, effectiveRemaining: 1, exhausted: false, fetchedAt: ts };
	}

	return {
		async getQuotas(providers: readonly string[], ttlMs = opts.ttlMs ?? 60_000, signal?: AbortSignal): Promise<Record<string, ProviderQuotaSnapshot>> {
			const ts = now();
			const unique = [...new Set(providers)];
			const stale = unique.filter((p) => {
				const hit = cache.get(p);
				return !hit || ts - hit.fetchedAt > ttlMs;
			});
			if (stale.length > 0) {
				const store = readAuth();
				const fetched = await Promise.all(stale.map((p) => fetchOne(p, store[p], signal)));
				for (const snap of fetched) cache.set(snap.provider, snap);
			}
			const out: Record<string, ProviderQuotaSnapshot> = {};
			for (const p of unique) {
				out[p] = cache.get(p) ?? { provider: p, fiveHourRemaining: 1, weeklyRemaining: 1, effectiveRemaining: 1, exhausted: false, fetchedAt: ts };
			}
			return out;
		},
		/** Mark a provider or model exhausted immediately when a turn fails with a rate/usage limit error. */
		markExhausted(provider: string, modelId?: string) {
			const ts = now();
			const prev = cache.get(provider);
			if (modelId && prev) {
				const unavailable = new Set(prev.unavailableModels ?? []);
				unavailable.add(modelId);
				cache.set(provider, { ...prev, unavailableModels: unavailable, fetchedAt: ts });
			} else {
				cache.set(provider, {
					provider,
					fiveHourRemaining: 0,
					weeklyRemaining: prev?.weeklyRemaining ?? 0,
					effectiveRemaining: 0,
					exhausted: true,
					fetchedAt: ts,
				});
			}
		},
	};
}
