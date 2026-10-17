/**
 * Apple Foundation Models (`FoundationModels` framework, macOS 26+) local
 * on-device provider.
 *
 * Apple's on-device language model is ~3B parameters with a 4,096-token context
 * window, runs privately on Apple Silicon (ANE/GPU) with zero marginal cost and
 * no network traffic, and requires no remote API key.
 *
 * Selectability:
 *   - On macOS 26+ (or when `autoEnable: true` is passed), `apiKey` is set to
 *     `LOCAL_CREDENTIAL_KEY` so Pi's availability check marks the provider
 *     immediately selectable in `/model`, `--model`, and the Decision Router
 *     without requiring a manual login step first.
 *   - `/login` is also provided: it runs `checkAppleFoundationAvailability`
 *     through the Swift bridge to verify `SystemLanguageModel.default.availability`
 *     and persists the local credential in `auth.json`.
 *
 * Full Tool & Option Exposure:
 *   - Every active tool declared in the Pi transcript (`getCurrentTools`),
 *     including its full JSON Schema `parameters` (properties, types, enums,
 *     descriptions, and `required` arrays), is serialized into `parametersSchemaJson`
 *     and passed into the Swift bridge's instructions.
 *   - When tools are present, the Swift bridge uses `@Generable` guided
 *     generation (`AssistantTurnDecision`) so the on-device 3B model can invoke
 *     any declared tool with structured JSON arguments or reply directly.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import {
	calculateCost, createAssistantMessageEventStream,
	type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { apiKeyCredentials } from "../../shared/index.ts";

export const PROVIDER_ID = "apple-foundation";
export const DISPLAY_NAME = "Apple Foundation Models (On-Device)";
export const API_ID = "apple-foundation-local";
export const BASE_URL = "https://apple-foundation.local";
export const LOCAL_CREDENTIAL_KEY = "apple-foundation-on-device";

export const MODEL_GENERAL_ID = "apple-foundation-local";
export const MODEL_TAGGING_ID = "apple-foundation-content-tagging";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Apple's on-device Foundation Model has a 4,096-token context window. */
export const CONTEXT_WINDOW = 4096;
export const MAX_OUTPUT_TOKENS = 2048;

export const MODELS: ProviderModelConfig[] = [
	{
		id: MODEL_GENERAL_ID,
		name: "Apple Foundation Model (On-Device 3B)",
		api: API_ID,
		baseUrl: BASE_URL,
		input: ["text"],
		reasoning: false,
		cost: ZERO_COST,
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_OUTPUT_TOKENS,
	},
	{
		id: MODEL_TAGGING_ID,
		name: "Apple Foundation Model Content Tagging (On-Device)",
		api: API_ID,
		baseUrl: BASE_URL,
		input: ["text"],
		reasoning: false,
		cost: ZERO_COST,
		contextWindow: CONTEXT_WINDOW,
		maxTokens: 1024,
	},
];

export interface BridgeToolOptionSpec {
	name: string;
	type: string;
	required: boolean;
	description?: string;
	enumValues?: string[];
}

export interface BridgeToolSpec {
	name: string;
	description?: string;
	/** Full JSON Schema string for the tool's parameters, options, types, and required fields. */
	parametersSchemaJson?: string;
	/** Extracted option descriptors so both the prompt and argument canonicalizer know the exact option names. */
	options?: BridgeToolOptionSpec[];
}

export interface BridgeRequest {
	mode: "check" | "generate";
	useCase?: "general" | "contentTagging";
	instructions?: string;
	prompt?: string;
	temperature?: number;
	maxTokens?: number;
	tools?: BridgeToolSpec[];
}

export interface BridgeEvent {
	type: "availability" | "delta" | "tool_call" | "done" | "error";
	available?: boolean;
	reason?: string;
	text?: string;
	toolName?: string;
	toolArgumentsJson?: string;
	error?: string;
}

export type BridgeRunner = (request: BridgeRequest, signal?: AbortSignal) => AsyncIterable<BridgeEvent>;

/**
 * Swift helper source compiled once into `~/.cache/pi-integrations/apple-foundation`.
 * Uses `FoundationModels` guided generation (`@Generable`) when tools are passed
 * so the 3B model sees every tool's name, description, and full JSON Schema
 * options and can either answer directly or emit a structured tool call.
 */
export const SWIFT_BRIDGE_SOURCE = `
import Foundation
#if canImport(FoundationModels)
import FoundationModels

@available(macOS 26.0, *)
@Generable(description: "Assistant response or a single tool invocation")
struct AssistantTurnDecision {
    @Guide(description: "Set to 'reply' to answer the user directly in plain text, or 'tool' ONLY when invoking one of the listed tools is required to read/modify files or run commands", .anyOf(["reply", "tool"]))
    var action: String
    @Guide(description: "When action is 'reply', the complete response text to the user; when action is 'tool', empty string")
    var reply: String
    @Guide(description: "When action is 'tool', the exact tool name from the available tools list; when action is 'reply', empty string")
    var toolName: String
    @Guide(description: "When action is 'tool', a valid JSON object string matching the tool's parameters JSON Schema; when action is 'reply', empty string")
    var toolArgumentsJson: String
}
#endif

struct BridgeToolOption: Decodable {
    let name: String
    let type: String
    let required: Bool
    let description: String?
    let enumValues: [String]?
}

struct BridgeTool: Decodable {
    let name: String
    let description: String?
    let parametersSchemaJson: String?
    let options: [BridgeToolOption]?
}

struct BridgeRequest: Decodable {
    let mode: String
    let useCase: String?
    let instructions: String?
    let prompt: String?
    let temperature: Double?
    let maxTokens: Int?
    let tools: [BridgeTool]?
}

func emit(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((line + "\\n").utf8))
    }
}

@main
struct Main {
    static func main() async {
        let inputData = FileHandle.standardInput.readDataToEndOfFile()
        guard let req = try? JSONDecoder().decode(BridgeRequest.self, from: inputData) else {
            emit(["type": "error", "error": "Invalid Apple Foundation Models bridge request JSON."])
            return
        }
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            let model: SystemLanguageModel = req.useCase == "contentTagging"
                ? SystemLanguageModel(useCase: .contentTagging)
                : SystemLanguageModel.default
            switch model.availability {
            case .available:
                if req.mode == "check" {
                    emit(["type": "availability", "available": true])
                    return
                }
            case .unavailable(let reason):
                emit(["type": "availability", "available": false, "reason": "\\(reason)"])
                return
            }
            let prompt = req.prompt ?? ""
            let instructions = req.instructions ?? "You are a concise, accurate on-device coding and reasoning assistant."
            var options = GenerationOptions()
            if let t = req.temperature, let m = req.maxTokens {
                options = GenerationOptions(temperature: t, maximumResponseTokens: m)
            } else if let t = req.temperature {
                options = GenerationOptions(temperature: t)
            } else if let m = req.maxTokens {
                options = GenerationOptions(maximumResponseTokens: m)
            }
            do {
                if let tools = req.tools, !tools.isEmpty, req.useCase != "contentTagging" {
                    let allowedNames = Set(tools.map { $0.name })
                    let toolList = tools.map { tool in
                        var entry = "- \\(tool.name): \\(tool.description ?? "")"
                        if let opts = tool.options, !opts.isEmpty {
                            let optLines = opts.map { opt in
                                let req = opt.required ? "required" : "optional"
                                let enums = (opt.enumValues?.isEmpty == false) ? " enum=[\\(opt.enumValues!.joined(separator: ", "))]" : ""
                                return "    • \\(opt.name) (\\(opt.type), \\(req)\\(enums)): \\(opt.description ?? "")"
                            }.joined(separator: "\\n")
                            entry += "\\n  exact parameter keys (use these exact names in toolArgumentsJson):\\n" + optLines
                        } else if let schema = tool.parametersSchemaJson, !schema.isEmpty {
                            entry += "\\n  parameters schema: \\(schema)"
                        }
                        return entry
                    }.joined(separator: "\\n")
                    let session = LanguageModelSession(
                        model: model,
                        instructions: instructions + "\\n\\nAvailable tools (set action='reply' for questions or explanations; set action='tool' ONLY when invoking a listed tool is strictly required, and use the exact parameter key names listed under the chosen tool):\\n" + toolList
                    )
                    let res = try await session.respond(to: prompt, generating: AssistantTurnDecision.self, options: options)
                    let d = res.content
                    if d.action == "tool" && allowedNames.contains(d.toolName) {
                        emit([
                            "type": "tool_call",
                            "toolName": d.toolName,
                            "toolArgumentsJson": d.toolArgumentsJson.isEmpty ? "{}" : d.toolArgumentsJson,
                        ])
                    } else if !d.reply.isEmpty {
                        emit(["type": "delta", "text": d.reply])
                    } else if !d.toolArgumentsJson.isEmpty {
                        emit(["type": "delta", "text": d.toolArgumentsJson])
                    }
                    emit(["type": "done"])
                } else {
                    let session = LanguageModelSession(model: model, instructions: instructions)
                    var previous = ""
                    let stream = session.streamResponse(to: prompt, options: options)
                    for try await partial in stream {
                        let current = partial.content
                        if current.hasPrefix(previous) {
                            let delta = String(current.dropFirst(previous.count))
                            if !delta.isEmpty { emit(["type": "delta", "text": delta]) }
                        } else {
                            emit(["type": "delta", "text": current])
                        }
                        previous = current
                    }
                    emit(["type": "done"])
                }
            } catch {
                emit(["type": "error", "error": "\\(error)"])
            }
            return
        }
        #endif
        emit(["type": "availability", "available": false, "reason": "Apple FoundationModels requires macOS 26 or newer on Apple Silicon."])
    }
}
`;

const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "pi-integrations", "apple-foundation");

const BINARY_PATH_NAME = "apple-fm-bridge-v2";

function findSwiftc(env: Record<string, string | undefined> = process.env): string {
	for (const candidate of [env.SWIFTC, "/usr/bin/swiftc", "/opt/homebrew/bin/swiftc"]) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return "swiftc";
}

/** Whether the host OS is macOS 26+ (Darwin kernel version >= 25) on Apple Silicon. */
export function isSupportedAppleHost(platform: string = process.platform, arch: string = process.arch, osRelease: string = release()): boolean {
	if (platform !== "darwin" || arch !== "arm64") return false;
	const major = Number.parseInt(osRelease.split(".")[0] ?? "0", 10);
	return Number.isFinite(major) && major >= 25;
}

/** Compile the Swift helper once and cache the Mach-O binary under `cacheDir`. */
export async function ensureSwiftBridgeBinary(
	env: Record<string, string | undefined> = process.env,
	cacheDir: string = DEFAULT_CACHE_DIR,
): Promise<string> {
	const sourcePath = join(cacheDir, "bridge.swift");
	const binaryPath = join(cacheDir, BINARY_PATH_NAME);
	try {
		if (
			statSync(binaryPath).isFile() &&
			existsSync(sourcePath) &&
			readFileSync(sourcePath, "utf8") === SWIFT_BRIDGE_SOURCE
		) {
			return binaryPath;
		}
	} catch { /* compile below */ }
	mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	writeFileSync(sourcePath, SWIFT_BRIDGE_SOURCE, { mode: 0o600 });
	const swiftc = findSwiftc(env);
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(swiftc, ["-O", "-parse-as-library", sourcePath, "-o", binaryPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		proc.on("error", (err) => reject(new Error(`Failed to launch swiftc: ${err.message}`)));
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Failed to compile Apple Foundation Models bridge (exit ${code}): ${stderr.slice(0, 300)}`));
		});
	});
	return binaryPath;
}

export const defaultBridgeRunner: BridgeRunner = async function* (request, signal) {
	signal?.throwIfAborted();
	const binary = await ensureSwiftBridgeBinary();
	signal?.throwIfAborted();
	const proc = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
	const onAbort = () => { proc.kill("SIGTERM"); };
	signal?.addEventListener("abort", onAbort, { once: true });
	proc.stdin.write(JSON.stringify(request));
	proc.stdin.end();
	let buffer = "";
	try {
		for await (const chunk of proc.stdout) {
			signal?.throwIfAborted();
			buffer += (chunk as Buffer).toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				yield JSON.parse(line) as BridgeEvent;
			}
		}
		if (buffer.trim()) yield JSON.parse(buffer) as BridgeEvent;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (proc.exitCode === null) proc.kill("SIGTERM");
	}
};

function schemaTypeLabel(prop: Record<string, unknown>): { type: string; enumValues?: string[] } {
	if (Array.isArray(prop.enum)) {
		return { type: "enum", enumValues: prop.enum.map(String) };
	}
	if (typeof prop.type === "string") return { type: prop.type };
	if (Array.isArray(prop.type)) return { type: prop.type.map(String).join("|") };
	if (Array.isArray(prop.anyOf)) {
		const parts = prop.anyOf
			.map((entry) => (entry && typeof entry === "object" ? (entry as { type?: unknown }).type : undefined))
			.filter((t): t is string => typeof t === "string");
		if (parts.length > 0) return { type: parts.join("|") };
	}
	return { type: "any" };
}

function extractToolOptions(parameters: unknown): BridgeToolOptionSpec[] {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return [];
	const schema = parameters as { properties?: unknown; required?: unknown };
	if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return [];
	const requiredSet = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);
	const options: BridgeToolOptionSpec[] = [];
	for (const [name, rawProp] of Object.entries(schema.properties as Record<string, unknown>)) {
		if (!rawProp || typeof rawProp !== "object" || Array.isArray(rawProp)) continue;
		const prop = rawProp as Record<string, unknown>;
		const { type, enumValues } = schemaTypeLabel(prop);
		const description = typeof prop.description === "string" ? prop.description.slice(0, 180) : undefined;
		options.push({
			name,
			type,
			required: requiredSet.has(name),
			...(description ? { description } : {}),
			...(enumValues ? { enumValues } : {}),
		});
	}
	return options;
}

const OPTION_SYNONYMS: Record<string, readonly string[]> = {
	path: ["filePath", "filepath", "file", "filename", "file_path", "targetPath"],
	offset: ["startIndex", "startLine", "lineOffset", "start", "fromLine", "line"],
	limit: ["maxLines", "count", "numLines", "lines", "maxCount"],
	command: ["cmd", "shellCommand", "bashCommand", "script"],
	timeout: ["timeoutSeconds", "timeoutMs", "maxTime"],
	content: ["text", "body", "fileContent", "data"],
	oldText: ["old_text", "search", "find", "before"],
	newText: ["new_text", "replace", "replacement", "after"],
};

/**
 * Canonicalize tool-call arguments emitted by the 3B model against the tool's
 * declared schema options: maps common synonym keys (`filePath` -> `path`,
 * `startIndex` -> `offset`) and fills required nullable options (`number|null`)
 * with `null` when omitted.
 */
export function canonicalizeToolArguments(
	rawArgs: Record<string, unknown>,
	toolSpec: BridgeToolSpec | undefined,
): Record<string, unknown> {
	if (!toolSpec?.options || toolSpec.options.length === 0) return rawArgs;
	const out: Record<string, unknown> = { ...rawArgs };
	for (const opt of toolSpec.options) {
		if (opt.name in out) continue;
		const synonyms = OPTION_SYNONYMS[opt.name] ?? [];
		for (const syn of synonyms) {
			if (syn in out) {
				out[opt.name] = out[syn];
				delete out[syn];
				break;
			}
		}
		if (!(opt.name in out) && opt.required && opt.type.includes("null")) {
			out[opt.name] = null;
		}
	}
	return out;
}

const DEFAULT_ON_DEVICE_INSTRUCTIONS =
	"You are a concise, accurate on-device coding and reasoning assistant. " +
	"Answer general, factual, and conceptual questions directly in plain text and then stop. " +
	"Never write answers to temporary files (such as /tmp/...) unless the user explicitly asks to create or write a file. " +
	"If a question requires live internet data (such as current weather or live web pricing) not present in the conversation, state clearly that real-time information is unavailable offline.";

/**
 * Strip Pi harness XML sections (`<tools>`, `<rules>`, `<docs>`, `<skills>`, `<mcp_servers>`)
 * and tool-forcing boilerplate so the 3B on-device model is not primed to invoke `write`
 * on conversational questions.
 */
export function sanitizeFoundationInstructions(rawSystemText: string): string {
	const stripped = rawSystemText
		.replace(/<(?:tools|rules|docs|skills|mcp_servers)>[\s\S]*?<\/(?:tools|rules|docs|skills|mcp_servers)>/gi, "")
		.replace(/You are an expert coding assistant operating inside pi, a coding agent harness\.\s*You help users by reading files, executing commands, editing code, and writing new files\./gi, "")
		.trim();
	if (!stripped) return DEFAULT_ON_DEVICE_INSTRUCTIONS;
	const combined = `${stripped}\n\n${DEFAULT_ON_DEVICE_INSTRUCTIONS}`;
	return combined.slice(0, 1800);
}

const BUILTIN_AGENT_TOOLS = new Set(["read", "bash", "edit", "write", "codemode"]);
const WRITE_INTENT_RE = /\b(write|create|save|overwrite|output\s+to|new\s+file|make\s+a\s+file)\b/i;
const EDIT_INTENT_RE = /\b(edit|modify|update|replace|patch|refactor|rename|fix\s+in|change\s+in)\b/i;
const EXEC_INTENT_RE = /\b(run|execute|bash|shell|terminal|command|script|git|ls|grep|rg|find\s+files|build|compile|test|codemode)\b/i;
const READ_INTENT_RE = /\b(read|inspect|open|view|cat|show\s+file|check\s+file|file\s+contents|lines?\s+\d+)\b/i;
const FILE_PATH_TOKEN_RE = /(?:^|[\s"'`(])(?:\.{1,2}\/|[~/][\w.-]+\/|[\w.-]+\/[\w./-]+|[\w.-]+\.(?:md|ts|tsx|js|mjs|cjs|json|swift|py|sh|txt|yaml|yml|toml|html|css|rs|go|c|h|cpp|java|rb|lock))\b/i;

type RawTranscriptMessage = {
	role?: string;
	content?: unknown;
	toolName?: string;
};

function findLastUserMessageIndex(messages: readonly RawTranscriptMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

function hasToolActivityInCurrentTurn(messages: readonly RawTranscriptMessage[], lastUserIdx: number): boolean {
	if (lastUserIdx < 0) return false;
	for (let i = lastUserIdx + 1; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "toolResult") return true;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b && typeof b === "object" && (b as { type?: string }).type === "toolCall") return true;
			}
		}
	}
	return false;
}

/**
 * Determine which declared tools should be active for the current turn on the
 * 3B on-device model:
 *   1. Once a tool has already executed in the current user turn, disable tools
 *      on the continuation step so the model synthesizes a final text answer and
 *      stops instead of repeating the same tool call in a loop.
 *   2. For built-in coding agent tools (`write`, `edit`, `bash`, `codemode`, `read`),
 *      only expose tools that match the user's request intent so plain questions
 *      never trigger unrequested `/tmp/*.txt` file writes.
 */
export function selectActiveToolsForTurn(
	tools: readonly BridgeToolSpec[],
	messages: readonly RawTranscriptMessage[],
): BridgeToolSpec[] {
	if (tools.length === 0) return [];
	const lastUserIdx = findLastUserMessageIndex(messages);
	if (lastUserIdx < 0) return [];
	if (hasToolActivityInCurrentTurn(messages, lastUserIdx)) return [];

	const userText = extractPlainText(messages[lastUserIdx]?.content).trim();
	if (!userText) return [];

	const hasFilePath = FILE_PATH_TOKEN_RE.test(userText);
	return tools.filter((tool) => {
		if (!BUILTIN_AGENT_TOOLS.has(tool.name)) return true;
		switch (tool.name) {
			case "write":
				return WRITE_INTENT_RE.test(userText);
			case "edit":
				return EDIT_INTENT_RE.test(userText);
			case "bash":
			case "codemode":
				return EXEC_INTENT_RE.test(userText);
			case "read":
				return READ_INTENT_RE.test(userText) || hasFilePath;
			default:
				return true;
		}
	});
}

export function parseToolArgumentsJson(raw: string | undefined): Record<string, unknown> {
	if (!raw || !raw.trim()) return {};
	const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	for (const candidate of [
		trimmed,
		// Repair stray trailing quote after numeric/boolean/null literals (e.g. `"limit": 20"`)
		trimmed.replace(/:\s*(-?\d+(?:\.\d+)?|true|false|null)"(\s*[,}])/g, ": $1$2"),
	]) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch { /* try next */ }
	}
	return {};
}

/**
 * Render a Pi transcript and its active tools (including every parameter option
 * and required field from the tool's JSON Schema) into a compact request within
 * the 4,096-token budget.
 */
export function buildFoundationPrompt(context: TranscriptContext): {
	instructions: string;
	prompt: string;
	tools: BridgeToolSpec[];
	activeTools: BridgeToolSpec[];
} {
	const normalized = collapseSystemMessages(context);
	const initialSystem = getInitialSystemMessage(normalized.messages as never);
	const systemText = initialSystem ? getSystemMessageText(initialSystem as never) : "";
	const instructions = sanitizeFoundationInstructions(systemText);

	const rawTools = getCurrentTools(normalized.messages as never) as Array<{
		name?: unknown;
		description?: unknown;
		parameters?: unknown;
	}>;

	const tools: BridgeToolSpec[] = [];
	for (const t of rawTools) {
		if (!t || typeof t.name !== "string" || !t.name.trim()) continue;
		let parametersSchemaJson: string | undefined;
		if (t.parameters && typeof t.parameters === "object") {
			try {
				parametersSchemaJson = JSON.stringify(t.parameters);
			} catch { /* ignore unserializable schema */ }
		}
		const options = extractToolOptions(t.parameters);
		tools.push({
			name: t.name,
			...(typeof t.description === "string" && t.description.trim() ? { description: t.description.slice(0, 280) } : {}),
			...(parametersSchemaJson ? { parametersSchemaJson } : {}),
			...(options.length > 0 ? { options } : {}),
		});
	}

	const messages = normalized.messages as RawTranscriptMessage[];
	const activeTools = selectActiveToolsForTurn(tools, messages);
	const lastUserIdx = findLastUserMessageIndex(messages);
	const toolContinuation = hasToolActivityInCurrentTurn(messages, lastUserIdx);

	const turns: string[] = [];
	const priorEnd = lastUserIdx >= 0 ? lastUserIdx : messages.length;
	for (let i = 0; i < priorEnd; i++) {
		const msg = messages[i];
		if (!msg || msg.role === "system" || msg.role === "toolResult") continue;
		// Omit raw tool-call traces from prior completed turns so they never act as
		// few-shot examples that encourage repeating tool calls on later questions.
		const text = extractPlainText(msg.content).trim();
		if (!text) continue;
		if (msg.role === "user") turns.push(`User: ${text}`);
		else if (msg.role === "assistant") turns.push(`Assistant: ${text}`);
	}

	if (lastUserIdx >= 0) {
		const userText = extractPlainText(messages[lastUserIdx]?.content).trim();
		if (toolContinuation) {
			const stepLines: string[] = [`User request: ${userText}`];
			for (let i = lastUserIdx + 1; i < messages.length; i++) {
				const msg = messages[i];
				if (!msg) continue;
				if (msg.role === "assistant") {
					const calls = extractToolCalls(msg.content);
					for (const call of calls) {
						stepLines.push(`Tool action executed: ${call.name}(${JSON.stringify(call.arguments ?? {})})`);
					}
					const text = extractPlainText(msg.content).trim();
					if (text) stepLines.push(`Assistant note: ${text}`);
				} else if (msg.role === "toolResult") {
					const resText = extractPlainText(msg.content).trim();
					stepLines.push(`Tool output (${msg.toolName ?? "result"}): ${resText}`);
				}
			}
			stepLines.push(
				"Using the tool action and tool output above, provide the final response to the user request directly and concisely. " +
				"Do not call any more tools, and do not claim information is missing if it already appears in the tool action or tool output above.",
			);
			turns.push(stepLines.join("\n\n"));
		} else if (userText) {
			turns.push(`User: ${userText}`);
		}
	}

	const joined = turns.join("\n\n");
	// Keep the most recent ~6,000 chars (~1,500 tokens) so tool schemas + response tokens fit in 4,096.
	const prompt = joined.length <= 6000 ? joined : joined.slice(-6000);
	return { instructions, prompt: prompt || "Hello", tools, activeTools };
}

function extractPlainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
			parts.push(b.text);
		}
	}
	return parts.join("\n");
}

function extractToolCalls(content: unknown): Array<{ name: string; arguments: unknown }> {
	if (!Array.isArray(content)) return [];
	const out: Array<{ name: string; arguments: unknown }> = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; name?: unknown; arguments?: unknown };
		if (b.type === "toolCall" && typeof b.name === "string") {
			out.push({ name: b.name, arguments: b.arguments ?? {} });
		}
	}
	return out;
}

export interface AppleFoundationDependencies {
	runner?: BridgeRunner;
	now?: () => number;
	/**
	 * When true (or by default on macOS 26+ Apple Silicon), exposes `apiKey` on
	 * the provider so the model is immediately selectable without requiring `/login`
	 * first, while keeping `/login` available for explicit verification.
	 */
	autoEnable?: boolean;
}

export function createAppleFoundationStreamSimple(deps: AppleFoundationDependencies = {}): NonNullable<ProviderConfig["streamSimple"]> {
	const runner = deps.runner ?? defaultBridgeRunner;
	const now = deps.now ?? Date.now;
	let toolCallSeq = 0;

	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const output: Record<string, unknown> & { content: Array<Record<string, unknown>>; usage: Record<string, unknown>; stopReason: string; errorMessage?: string } = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending",
			timestamp: now(),
		};
		const push = (event: unknown) => stream.push(event as never);

		(async () => {
			try {
				options?.signal?.throwIfAborted();
				const { instructions, prompt, tools, activeTools } = buildFoundationPrompt(context);
				const useCase = model.id === MODEL_TAGGING_ID ? "contentTagging" : "general";
				const optRecord = options as { temperature?: unknown; maxTokens?: unknown } | undefined;
				const req: BridgeRequest = {
					mode: "generate",
					useCase,
					instructions,
					prompt,
					...(typeof optRecord?.temperature === "number" ? { temperature: optRecord.temperature } : {}),
					...(typeof optRecord?.maxTokens === "number" ? { maxTokens: optRecord.maxTokens } : {}),
					...(activeTools.length > 0 ? { tools: activeTools } : {}),
				};
				await options?.onPayload?.(req, model);

				const activeToolNames = new Set(activeTools.map((t) => t.name));
				const seenToolSignatures = new Set<string>();

				push({ type: "start", partial: output });
				let textBlock: { type: "text"; text: string } | null = null;
				let outputChars = 0;

				const closeTextBlock = () => {
					if (!textBlock) return;
					push({ type: "text_end", contentIndex: output.content.length - 1, content: textBlock.text, partial: output });
					textBlock = null;
				};
				const appendDelta = (deltaText: string) => {
					if (!deltaText) return;
					if (!textBlock) {
						textBlock = { type: "text", text: "" };
						output.content.push(textBlock);
						push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					}
					textBlock.text += deltaText;
					outputChars += deltaText.length;
					push({ type: "text_delta", contentIndex: output.content.length - 1, delta: deltaText, partial: output });
				};

				for await (const ev of runner(req, options?.signal)) {
					if (ev.type === "availability" && ev.available === false) {
						throw new Error(`Apple Foundation Models is unavailable on this machine: ${ev.reason ?? "unavailable"}`);
					}
					if (ev.type === "error") {
						throw new Error(`Apple Foundation Models error: ${ev.error ?? "unknown error"}`);
					}
					if (ev.type === "delta" && typeof ev.text === "string" && ev.text.length > 0) {
						appendDelta(ev.text);
					}
					if (ev.type === "tool_call" && typeof ev.toolName === "string") {
						const declaredTool = tools.find((t) => t.name === ev.toolName);
						const args = canonicalizeToolArguments(parseToolArgumentsJson(ev.toolArgumentsJson), declaredTool);
						const sig = `${ev.toolName}:${JSON.stringify(args)}`;

						// Guard against unrequested or duplicate tool calls: if the tool is not
						// active for this turn or has already been emitted, convert any embedded
						// text payload into a direct reply instead of looping toolUse.
						if (!activeToolNames.has(ev.toolName) || seenToolSignatures.has(sig)) {
							const fallbackText = typeof args.content === "string" && args.content.trim()
								? args.content.trim()
								: typeof args.text === "string" && args.text.trim()
									? args.text.trim()
									: "";
							if (fallbackText && outputChars === 0) {
								appendDelta(fallbackText);
							}
							continue;
						}
						seenToolSignatures.add(sig);

						closeTextBlock();
						const id = `apple_fm_call_${++toolCallSeq}`;
						const block = { type: "toolCall", id, name: ev.toolName, arguments: args };
						output.content.push(block);
						const idx = output.content.length - 1;
						push({ type: "toolcall_start", contentIndex: idx, partial: output });
						push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(args), partial: output });
						push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
						output.stopReason = "toolUse";
					}
				}

				closeTextBlock();
				const estIn = Math.max(1, Math.ceil((instructions.length + prompt.length) / 4));
				const estOut = Math.ceil(outputChars / 4);
				output.usage = {
					input: estIn, output: estOut, cacheRead: 0, cacheWrite: 0, totalTokens: estIn + estOut,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				if ((model as { cost?: unknown }).cost) {
					calculateCost(model as never, output.usage as never);
				}
				if (output.stopReason === "pending") output.stopReason = "stop";
				push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			} catch (error) {
				const aborted = Boolean(options?.signal?.aborted);
				output.stopReason = aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();

		return stream;
	};
}

export async function checkAppleFoundationAvailability(
	runner: BridgeRunner = defaultBridgeRunner,
	signal?: AbortSignal,
): Promise<{ available: boolean; reason?: string }> {
	for await (const ev of runner({ mode: "check", useCase: "general" }, signal)) {
		if (ev.type === "availability") return { available: ev.available === true, reason: ev.reason };
		if (ev.type === "error") return { available: false, reason: ev.error };
	}
	return { available: false, reason: "Apple Foundation Models bridge returned no availability status." };
}

export function createAppleFoundationProvider(deps: AppleFoundationDependencies = {}): ProviderConfig {
	const runner = deps.runner ?? defaultBridgeRunner;
	const now = deps.now ?? Date.now;
	const streamSimple = createAppleFoundationStreamSimple({ runner, now });
	const autoEnable = deps.autoEnable;

	return {
		name: DISPLAY_NAME,
		baseUrl: BASE_URL,
		api: API_ID,
		...(autoEnable ? { apiKey: LOCAL_CREDENTIAL_KEY } : {}),
		models: MODELS,
		streamSimple,
		oauth: {
			name: DISPLAY_NAME,
			isSubscription: true,
			login: async (callbacks) => {
				callbacks.signal?.throwIfAborted();
				callbacks.onProgress?.("Checking on-device Apple Foundation Models availability…");
				const status = await checkAppleFoundationAvailability(runner, callbacks.signal);
				if (!status.available) {
					throw new Error(`Apple Foundation Models is not available: ${status.reason ?? "enable Apple Intelligence on macOS 26+."}`);
				}
				return apiKeyCredentials(LOCAL_CREDENTIAL_KEY, now());
			},
			refreshToken: async (credentials, signal) => {
				signal?.throwIfAborted();
				return credentials;
			},
			getApiKey: (credentials) => credentials.access || LOCAL_CREDENTIAL_KEY,
		},
	};
}
