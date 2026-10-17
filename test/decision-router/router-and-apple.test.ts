import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { getModels, normalizeContext } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	API_ID as APPLE_API_ID,
	buildFoundationPrompt,
	checkAppleFoundationAvailability,
	createAppleFoundationProvider,
	createAppleFoundationStreamSimple,
	ensureSwiftBridgeBinary,
	LOCAL_CREDENTIAL_KEY,
	MODEL_GENERAL_ID,
	MODEL_TAGGING_ID,
	PROVIDER_ID as APPLE_PROVIDER_ID,
	type BridgeEvent,
	type BridgeRequest,
	type BridgeRunner,
} from "../../src/domains/apple-foundation/provider.ts";
import appleFoundationEntry from "../../src/domains/apple-foundation/index.ts";
import {
	classifyPrompt,
	heuristicClassifyPrompt,
	resolveRequestedMode,
	selectBestCandidate,
	type ModelLookup,
} from "../../src/domains/decision-router/classifier.ts";
import {
	DEFAULT_ROUTER_CONFIG,
	loadRouterConfig,
	type DecisionRouterConfig,
} from "../../src/domains/decision-router/config.ts";
import {
	createQuotaTracker,
	parseAgyQuotaSummary,
	parseClaudeUsage,
	parseCodexUsage,
} from "../../src/domains/decision-router/quota.ts";
import {
	createDecisionVirtualModels,
	ROUTER_MODEL_ID,
	ROUTER_PROVIDER_ID,
} from "../../src/domains/decision-router/router.ts";
import decisionRouterEntry from "../../src/domains/decision-router/index.ts";

// ---------------------------------------------------------------------------
// 1. Apple Foundation Models: tool schema exposure, auto-selectability,
//    OAuth login enablement, and real Swift bridge compilation
// ---------------------------------------------------------------------------

test("buildFoundationPrompt exposes every tool call with its full parameter options and required fields", () => {
	const context = normalizeContext({
		systemPrompt: "You are a careful coding agent.",
		tools: [
			{
				name: "bash",
				description: "Execute a bash command",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "Shell command to execute" },
						timeout: { type: ["number", "null"], description: "Timeout in seconds" },
					},
					required: ["command", "timeout"],
				},
			},
			{
				name: "read",
				description: "Read file contents",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "File path to read" },
						offset: { type: ["number", "null"], description: "1-indexed start line" },
						limit: { type: ["number", "null"], description: "Max lines to read" },
					},
					required: ["path", "offset", "limit"],
				},
			},
		] as never,
		messages: [{ role: "user", content: "Read README.md lines 1 to 20", timestamp: 0 }],
	});

	const built = buildFoundationPrompt(context);
	assert.equal(built.tools.length, 2);
	assert.equal(built.tools[0]?.name, "bash");
	assert.ok(built.tools[0]?.parametersSchemaJson, "full parameters schema JSON must be preserved on each tool");
	const bashSchema = JSON.parse(built.tools[0]!.parametersSchemaJson!);
	assert.deepEqual(bashSchema.required, ["command", "timeout"]);
	assert.equal(bashSchema.properties.command.type, "string");
	assert.deepEqual(bashSchema.properties.timeout.type, ["number", "null"]);

	const readSchema = JSON.parse(built.tools[1]!.parametersSchemaJson!);
	assert.deepEqual(readSchema.required, ["path", "offset", "limit"]);
	assert.equal(readSchema.properties.path.description, "File path to read");
});

test("Apple Foundation Models stream passes full tool schemas to the bridge and emits toolUse events", async () => {
	const seenRequests: BridgeRequest[] = [];
	const runner: BridgeRunner = async function* (req): AsyncGenerator<BridgeEvent> {
		seenRequests.push(req);
		yield {
			type: "tool_call",
			toolName: "read",
			toolArgumentsJson: JSON.stringify({ path: "README.md", offset: 1, limit: 20 }),
		};
		yield { type: "done" };
	};

	const streamSimple = createAppleFoundationStreamSimple({ runner, now: () => 1700000000000 });
	const context = normalizeContext({
		systemPrompt: "Use tools.",
		tools: [
			{
				name: "read",
				description: "Read a file",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						offset: { type: ["number", "null"] },
						limit: { type: ["number", "null"] },
					},
					required: ["path", "offset", "limit"],
				},
			},
		] as never,
		messages: [{ role: "user", content: "Inspect README.md", timestamp: 0 }],
	});

	const model = {
		id: MODEL_GENERAL_ID,
		name: "Apple FM",
		api: APPLE_API_ID,
		provider: APPLE_PROVIDER_ID,
		baseUrl: "https://apple-foundation.local",
	} as never;

	const stream = streamSimple(model, context);
	const events: Array<{ type: string }> = [];
	for await (const ev of stream as unknown as AsyncIterable<{ type: string }>) {
		events.push(ev);
	}
	const final = await (stream as unknown as { finalResultPromise: Promise<{ stopReason: string; content: Array<{ type: string; name?: string; arguments?: unknown }> }> }).finalResultPromise;

	assert.equal(seenRequests.length, 1);
	assert.equal(seenRequests[0]?.tools?.[0]?.name, "read");
	assert.ok(seenRequests[0]?.tools?.[0]?.parametersSchemaJson?.includes("\"offset\""));
	assert.equal(final.stopReason, "toolUse");
	assert.equal(final.content[0]?.type, "toolCall");
	assert.equal(final.content[0]?.name, "read");
	assert.deepEqual(final.content[0]?.arguments, { path: "README.md", offset: 1, limit: 20 });
	assert.ok(events.some((e) => e.type === "toolcall_start"));
	assert.ok(events.some((e) => e.type === "toolcall_end"));
});

test("Apple Foundation Models provider is both auto-selectable on macOS 26+ and explicitly enableable via /login", async () => {
	const runner: BridgeRunner = async function* (req) {
		if (req.mode === "check") {
			yield { type: "availability", available: true };
			return;
		}
		yield { type: "delta", text: "Hello from on-device model" };
		yield { type: "done" };
	};

	const provider = createAppleFoundationProvider({ runner, now: () => 1700000000000, autoEnable: true });
	assert.equal(provider.models?.length, 2);
	assert.deepEqual(provider.models?.map((m) => m.id), [MODEL_GENERAL_ID, MODEL_TAGGING_ID]);

	// Auto-selectability: when Apple Intelligence is available on the host, the
	// provider exposes a default local credential so Pi's availability check passes
	// immediately without requiring a manual /login step first.
	assert.equal(provider.apiKey, LOCAL_CREDENTIAL_KEY);

	// And /login also works to explicitly verify & persist the credential in auth.json:
	const creds = await provider.oauth!.login({
		onAuth: () => {},
		onPrompt: async () => "",
		onProgress: () => {},
		onDeviceCode: () => {},
		onSelect: async () => undefined,
	});
	assert.equal(creds.access, LOCAL_CREDENTIAL_KEY);
});

test("Swift bridge source compiles cleanly with swiftc and reports live availability", async () => {
	const tempDir = join(tmpdir(), `pi-apple-fm-bridge-test-${Date.now()}`);
	try {
		const binaryPath = await ensureSwiftBridgeBinary(process.env, tempDir);
		assert.ok(binaryPath.endsWith("apple-fm-bridge-v2"));
		const status = await checkAppleFoundationAvailability();
		assert.equal(typeof status.available, "boolean");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 2. Decision Router: estimatedAccuracy + estimatedLatencyMs, quota parsing,
//    System One classification, and multi-objective candidate selection
// ---------------------------------------------------------------------------

test("every configured tier candidate declares both estimatedAccuracy and estimatedLatencyMs from latest benchmarks", () => {
	const config = loadRouterConfig({}, () => undefined);
	for (const tier of ["lowest", "medium", "highest"] as const) {
		assert.ok(config.tiers[tier].length >= 4, `${tier} tier should have at least 4 candidates`);
		for (const candidate of config.tiers[tier]) {
			assert.equal(typeof candidate.estimatedAccuracy, "number", `${candidate.provider}/${candidate.id} needs estimatedAccuracy`);
			assert.ok(candidate.estimatedAccuracy > 0 && candidate.estimatedAccuracy <= 1, `${candidate.id} estimatedAccuracy in (0, 1]`);
			assert.equal(typeof candidate.estimatedLatencyMs, "number", `${candidate.provider}/${candidate.id} needs estimatedLatencyMs`);
			assert.ok(candidate.estimatedLatencyMs > 0 && candidate.estimatedLatencyMs < 60_000, `${candidate.id} estimatedLatencyMs in (0, 60000)`);
		}
	}
	for (const [provider, sub] of Object.entries(config.subscriptions)) {
		assert.equal(typeof sub.estimatedAccuracy, "number", `subscription ${provider} needs estimatedAccuracy`);
		assert.equal(typeof sub.estimatedLatencyMs, "number", `subscription ${provider} needs estimatedLatencyMs`);
	}
});

test("quota parsers accurately extract remaining fractions and model blocks from Claude, Codex, and Antigravity", () => {
	const claude = parseClaudeUsage({
		five_hour: { utilization: 4.0, locked_reason: null },
		seven_day: { utilization: 69.0, locked_reason: null },
	}, 1000);
	assert.ok(claude);
	assert.equal(claude.fiveHourRemaining, 0.96);
	assert.equal(claude.weeklyRemaining, 0.31);
	assert.equal(claude.effectiveRemaining, 0.31);
	assert.equal(claude.exhausted, false);

	const codex = parseCodexUsage({
		plan_type: "plus",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: { used_percent: 5 },
			secondary_window: { used_percent: 76 },
		},
		model_usage: {
			"gpt-6-astra": { available: false },
		},
	}, 1000);
	assert.ok(codex);
	assert.equal(codex.fiveHourRemaining, 0.95);
	assert.equal(codex.weeklyRemaining, 0.24);
	assert.equal(codex.effectiveRemaining, 0.24);
	assert.ok(codex.unavailableModels?.has("gpt-6-astra"));
	assert.ok(codex.unavailableModels?.has("gpt-5.5"));

	const agy = parseAgyQuotaSummary({
		groups: [{
			buckets: [
				{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.91 },
				{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.99 },
			],
		}],
	}, 1000);
	assert.ok(agy);
	assert.equal(agy.fiveHourRemaining, 0.99);
	assert.equal(agy.weeklyRemaining, 0.91);
	assert.equal(agy.effectiveRemaining, 0.91);
});

test("classifyPrompt queries the local System One decision model and falls back cleanly when offline", async () => {
	const classification = await classifyPrompt({
		prompt: "Design a lock-free work-stealing deque in Rust with ABA protection",
		config: DEFAULT_ROUTER_CONFIG,
		registry: { find: () => undefined },
		fetchImpl: async () => new Response(JSON.stringify({
			answers: {
				tier: { type: "choice", choice: "highest", confidence: 0.88 },
				task_profile: { type: "choice", choice: "deep_architecture", confidence: 0.91 },
				local_ok: { type: "noul", noul: 0.04 },
			},
		}), { status: 200 }),
	});
	assert.equal(classification.tier, "highest");
	assert.equal(classification.taskProfile, "deep_architecture");
	assert.equal(classification.localEligibleProbability, 0.04);

	const fallback = await classifyPrompt({
		prompt: "Fix the typo in README.md line 2",
		config: DEFAULT_ROUTER_CONFIG,
		registry: { find: () => undefined },
		fetchImpl: async () => { throw new Error("connection refused"); },
	});
	assert.equal(fallback.tier, "lowest");
	assert.equal(fallback.source, "heuristic");
	assert.equal(heuristicClassifyPrompt("Add a CLI flag and unit tests").tier, "medium");
	assert.equal(resolveRequestedMode("low"), "lowest");
	assert.equal(resolveRequestedMode("medium"), "medium");
	assert.equal(resolveRequestedMode("high"), "highest");
	assert.equal(resolveRequestedMode("xhigh"), "auto");
});

test("selectBestCandidate weighs estimatedAccuracy, estimatedLatencyMs, quota headroom, and price, and reroutes when exhausted", () => {
	const catalog = new Map<string, ReturnType<typeof getModels>[number]>();
	for (const c of [
		...DEFAULT_ROUTER_CONFIG.tiers.lowest,
		...DEFAULT_ROUTER_CONFIG.tiers.medium,
		...DEFAULT_ROUTER_CONFIG.tiers.highest,
	]) {
		catalog.set(`${c.provider}/${c.id}`, {
			id: c.id,
			name: c.id,
			api: "openai-completions",
			provider: c.provider,
			baseUrl: "https://example.test",
			reasoning: true,
			input: ["text"],
			cost: { input: c.estimatedInputUsdPerM ?? 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: c.localOnly ? 4096 : 272_000,
			maxTokens: 8192,
		} as never);
	}
	const registry: ModelLookup = {
		find: (provider, id) => catalog.get(`${provider}/${id}`),
	};

	// 1. Trivial quick edit with high local_ok selects Apple Foundation Models (0 cost, lowest latency)
	const lowPick = selectBestCandidate({
		targetTier: "lowest",
		classification: {
			tier: "lowest",
			tierConfidence: 0.9,
			taskProfile: "quick_edit",
			localEligibleProbability: 0.92,
			source: "vllm-d3-lite",
		},
		config: DEFAULT_ROUTER_CONFIG,
		quotas: {},
		registry,
		estimatedPromptTokens: 200,
	});
	assert.equal(lowPick.candidate.provider, "apple-foundation");
	assert.equal(lowPick.candidate.id, MODEL_GENERAL_ID);
	assert.ok(lowPick.estimatedLatencyMs <= 600);

	// 2. Highest tier when Claude and Codex are exhausted routes to Antigravity Gemini 4 Argon High
	const highPick = selectBestCandidate({
		targetTier: "highest",
		classification: {
			tier: "highest",
			tierConfidence: 0.9,
			taskProfile: "deep_architecture",
			localEligibleProbability: 0.02,
			source: "vllm-d3-lite",
		},
		config: DEFAULT_ROUTER_CONFIG,
		quotas: {
			"claude-subscription": { provider: "claude-subscription", fiveHourRemaining: 0, weeklyRemaining: 0.3, effectiveRemaining: 0, exhausted: true, fetchedAt: 0 },
			"codex-subscription": { provider: "codex-subscription", fiveHourRemaining: 0, weeklyRemaining: 0.2, effectiveRemaining: 0, exhausted: true, fetchedAt: 0 },
			"agy-subscription": { provider: "agy-subscription", fiveHourRemaining: 0.99, weeklyRemaining: 0.95, effectiveRemaining: 0.95, exhausted: false, fetchedAt: 0 },
		},
		registry,
		estimatedPromptTokens: 2000,
	});
	assert.equal(highPick.candidate.provider, "agy-subscription");
});

test("decisionVirtualModels register cleanly and reroute on retry after a quota failure", async () => {
	const virtuals: Array<{ provider: string; id: string }> = [];
	const pi = {
		registerVirtualModel: (def: { provider: string; id: string }) => { virtuals.push({ provider: def.provider, id: def.id }); },
		registerProvider: () => {},
	} as unknown as ExtensionAPI;

	decisionRouterEntry(pi);
	appleFoundationEntry(pi);
	assert.ok(virtuals.some((v) => v.provider === ROUTER_PROVIDER_ID && v.id === ROUTER_MODEL_ID));

	const defs = createDecisionVirtualModels({
		readAuthStore: () => ({}),
		fetchImpl: async () => new Response(JSON.stringify({
			answers: {
				tier: { type: "choice", choice: "highest", confidence: 0.9 },
				task_profile: { type: "choice", choice: "deep_architecture", confidence: 0.9 },
				local_ok: { type: "noul", noul: 0.01 },
			},
		}), { status: 200 }),
	});
	const mainRouter = defs.find((d) => d.id === ROUTER_MODEL_ID)!;

	const opusModel = { id: "claude-opus-5-5", provider: "claude-subscription", api: "anthropic-messages", contextWindow: 1_000_000 } as never;
	const solModel = { id: "gpt-6.1-sol", provider: "codex-subscription", api: "openai-codex-responses", contextWindow: 500_000 } as never;
	const ctx = {
		modelRegistry: {
			find: (p: string, id: string) => {
				if (p === "claude-subscription" && id === "claude-opus-5-5") return opusModel;
				if (p === "codex-subscription" && id === "gpt-6.1-sol") return solModel;
				return undefined;
			},
		},
	} as unknown as ExtensionContext;

	const firstRoute = await mainRouter.route({
		model: { id: "router", provider: ROUTER_PROVIDER_ID } as never,
		thinkingLevel: "xhigh",
		reason: "user",
		messages: [{ role: "user", content: "Prove this lock-free queue linearizable", timestamp: 0 }] as never,
	}, ctx);
	assert.equal(firstRoute.model.provider, "codex-subscription");
	assert.equal(firstRoute.model.id, "gpt-6.1-sol");

	// Simulate a retry where codex-subscription returned a usage-limit error:
	const retryRoute = await mainRouter.route({
		model: { id: "router", provider: ROUTER_PROVIDER_ID } as never,
		thinkingLevel: "xhigh",
		reason: "retry",
		failed: {
			model: solModel,
			thinkingLevel: "high",
			message: { role: "assistant", stopReason: "error", errorMessage: "You've hit your usage limit" } as never,
		},
		messages: [{ role: "user", content: "Prove this lock-free queue linearizable", timestamp: 0 }] as never,
	}, ctx);
	assert.equal(retryRoute.model.provider, "claude-subscription");
	assert.equal(retryRoute.model.id, "claude-opus-5-5");
});

test("Spettro Velo 3.1 Flash is promoted in medium tier as a free Sonnet-level candidate", () => {
	const catalog = new Map<string, ReturnType<typeof getModels>[number]>();
	for (const c of DEFAULT_ROUTER_CONFIG.tiers.medium) {
		catalog.set(`${c.provider}/${c.id}`, {
			id: c.id,
			name: c.id,
			api: "openai-completions",
			provider: c.provider,
			baseUrl: "https://example.test",
			reasoning: true,
			input: ["text"],
			cost: { input: c.estimatedInputUsdPerM ?? 0, output: c.estimatedOutputUsdPerM ?? 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		} as never);
	}
	const pick = selectBestCandidate({
		targetTier: "medium",
		classification: {
			tier: "medium",
			tierConfidence: 0.9,
			taskProfile: "code_implementation",
			localEligibleProbability: 0.2,
			source: "vllm-d3-lite",
		},
		config: DEFAULT_ROUTER_CONFIG,
		quotas: {},
		registry: { find: (p, id) => catalog.get(`${p}/${id}`) },
		estimatedPromptTokens: 1500,
	});
	assert.equal(pick.candidate.provider, "spettro");
	assert.equal(pick.candidate.id, "Velo 3.1 Flash");
	assert.equal(pick.candidate.freeModel, true);
	assert.ok(pick.estimatedAccuracy >= 0.9);
});

test("Apple Foundation Models suppresses unrequested write tool calls on questions and stops after tool continuation", async () => {
	const piTools = [
		{
			name: "read",
			description: "Read file contents",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, offset: { type: ["number", "null"] }, limit: { type: ["number", "null"] } },
				required: ["path", "offset", "limit"],
			},
		},
		{
			name: "write",
			description: "Write content to a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
		},
	];

	// 1. Plain questions ("what is the weather todaz", "what is the height of the eiffel tower",
	//    "could you find the latest pricing for claude subscription") must NOT expose `write` or `read`.
	for (const question of [
		"what is the weather todaz",
		"what is the height of the eiffel tower",
		"could you find the latest pricing for claude subscription",
	]) {
		const ctx = normalizeContext({
			systemPrompt: "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n<tools>\n- write: Create or overwrite files\n</tools>",
			tools: piTools as never,
			messages: [{ role: "user", content: question, timestamp: 0 }],
		});
		const built = buildFoundationPrompt(ctx);
		assert.equal(built.tools.length, 2, "declared tools remain preserved on built.tools");
		assert.equal(built.activeTools.length, 0, `plain question "${question}" must not activate file/shell tools`);
		assert.ok(!built.instructions.includes("<tools>"), "Pi <tools> XML block must be stripped from on-device instructions");
	}

	// 2. Even if a faulty runner emits an unrequested `write` tool_call with content,
	//    streamSimple converts it into a direct text reply (stopReason: "stop") instead of writing /tmp files or looping.
	const model = {
		id: MODEL_GENERAL_ID,
		name: "Apple FM",
		api: APPLE_API_ID,
		provider: APPLE_PROVIDER_ID,
		baseUrl: "https://apple-foundation.local",
	} as never;

	const faultyRunner: BridgeRunner = async function* () {
		yield {
			type: "tool_call",
			toolName: "write",
			toolArgumentsJson: JSON.stringify({ path: "/tmp/eiffel_tower.txt", content: "324 meters" }),
		};
		yield { type: "done" };
	};
	const streamSimple = createAppleFoundationStreamSimple({ runner: faultyRunner, now: () => 1700000000000 });
	const questionCtx = normalizeContext({
		systemPrompt: "Answer questions.",
		tools: piTools as never,
		messages: [{ role: "user", content: "what is the height of the eiffel tower", timestamp: 0 }],
	});
	const s = streamSimple(model, questionCtx);
	for await (const _ of s as unknown as AsyncIterable<unknown>) { /* consume */ }
	const res = await (s as unknown as { finalResultPromise: Promise<{ stopReason: string; content: Array<{ type: string; text?: string }> }> }).finalResultPromise;
	assert.equal(res.stopReason, "stop");
	assert.equal(res.content.length, 1);
	assert.equal(res.content[0]?.type, "text");
	assert.equal(res.content[0]?.text, "324 meters");

	// 3. On a legitimate tool continuation turn (after a toolResult is present in the current user turn),
	//    activeTools is empty so the bridge cannot repeat the tool call in a loop, and the prompt
	//    includes both the executed tool action and tool output so the model does not contradict itself.
	const continuationCtx = normalizeContext({
		systemPrompt: "Use tools.",
		tools: piTools as never,
		messages: [
			{ role: "user", content: "Read README.md lines 1 to 10", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md", offset: 1, limit: 10 } }],
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "# pi-integrations" }],
				isError: false,
				timestamp: 2,
			} as never,
		],
	});
	const contBuilt = buildFoundationPrompt(continuationCtx);
	assert.equal(contBuilt.activeTools.length, 0, "continuation turn after toolResult must disable tools to prevent repetition loops");
	assert.ok(contBuilt.prompt.includes("Tool action executed: read("), "continuation prompt must include executed tool action");
	assert.ok(contBuilt.prompt.includes("Tool output (read): # pi-integrations"), "continuation prompt must include tool output");
});

