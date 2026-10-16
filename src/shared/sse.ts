/**
 * Minimal, bounded Server-Sent Events reader for streaming provider responses.
 *
 * Unlike the one-shot HTTP helpers (which cap the whole body), a stream can run
 * for minutes, so the bound here is per EVENT. Handles CRLF/LF/CR line endings,
 * multi-line `data:`, comments, an optional BOM, and a final unterminated event.
 * Never retries and never logs payloads.
 */
export interface SseEvent { event?: string; data: string }

export const SSE_MAX_EVENT_BYTES = 4 * 1024 * 1024;

export async function* iterateSse(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	maxEventBytes: number = SSE_MAX_EVENT_BYTES,
): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "";
	let first = true;
	let event: string | undefined;
	let data: string[] = [];
	let eventBytes = 0;
	const flush = (): SseEvent | undefined => {
		if (data.length === 0) { event = undefined; eventBytes = 0; return undefined; }
		const out: SseEvent = { ...(event !== undefined ? { event } : {}), data: data.join("\n") };
		event = undefined; data = []; eventBytes = 0;
		return out;
	};
	const handleLine = (line: string): SseEvent | undefined => {
		if (line === "") return flush();
		if (line.startsWith(":")) return undefined;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		eventBytes += line.length;
		if (eventBytes > maxEventBytes) throw new Error("Provider stream event too large.");
		if (field === "data") data.push(value);
		else if (field === "event") event = value;
		return undefined;
	};
	// A pending read must not outlive an abort even if the transport ignores the signal.
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		if (!signal) return;
		onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
	});
	aborted.catch(() => {});
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			if (first) { buffer = buffer.replace(/^\uFEFF/, ""); first = false; }
			// A lone trailing CR may be half of a CRLF; keep it for the next chunk.
			const held = buffer.endsWith("\r") ? "\r" : "";
			const complete = held ? buffer.slice(0, -1) : buffer;
			const lines = complete.split(/\r\n|\n|\r/);
			buffer = lines.pop()! + held;
			if (buffer.length > maxEventBytes) throw new Error("Provider stream event too large.");
			for (const line of lines) {
				const out = handleLine(line);
				if (out) yield out;
			}
		}
		buffer += decoder.decode();
		for (const line of buffer.split(/\r\n|\n|\r/)) {
			const out = handleLine(line);
			if (out) yield out;
		}
		const last = flush();
		if (last) yield last;
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
