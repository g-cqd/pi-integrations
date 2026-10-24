/**
 * Gemini 3 and later reject a replayed function call that has no thought
 * signature ("Function call is missing a thought_signature"). Pi's converter
 * keeps a signature only when the same provider and model produced it, so a
 * history that came from another model reaches the backend unsigned.
 * Google documents this sentinel for that case:
 * https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const GEMINI_MAJOR_RE = /^gemini(?:-live)?-(\d+)/i;

interface Part { functionCall?: unknown; thoughtSignature?: unknown }
interface Content { role?: string; parts?: Part[] }

/**
 * Mark the first unsigned function call of each model turn with the sentinel.
 *
 * Only the first call of a turn is validated; later parallel calls carry no
 * signature in a genuine response either. The array is changed in place.
 *
 * - Parameter modelId: the backend model id. Other than Gemini 3 or later, the contents stay unchanged.
 * - Parameter contents: the Gemini `contents` built by Pi's converter.
 * - Complexity: O(total parts).
 */
export function signReplayedFunctionCalls(modelId: string, contents: Content[]): void {
	const major = GEMINI_MAJOR_RE.exec(modelId)?.[1];
	if (major === undefined || Number.parseInt(major, 10) < 3) return;
	for (const content of contents) {
		if (content.role !== "model" || !content.parts) continue;
		const first = content.parts.find((part) => part.functionCall !== undefined);
		if (first && !first.thoughtSignature) first.thoughtSignature = SKIP_THOUGHT_SIGNATURE;
	}
}
