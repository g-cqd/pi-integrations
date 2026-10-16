/** Credential-safe HTTP primitives. No retries, redirects, or payload logging. */
export type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface HttpOptions { fetchImpl?: FetchImplementation; signal?: AbortSignal }
export const RESPONSE_LIMIT_BYTES = 1024 * 1024;

export class HttpStatusError extends Error {
	constructor(public readonly status: number) { super(`Provider request returned HTTP ${status}.`); }
}

async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > RESPONSE_LIMIT_BYTES) throw new Error("Provider response too large.");
			chunks.push(value);
		}
	} catch {
		await reader.cancel().catch(() => {});
		throw new Error("Invalid or oversized provider response.");
	} finally {
		reader.releaseLock();
	}
	signal.throwIfAborted();
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Preserve HTTP status for domain-specific handling without leaking transport errors. */
export async function requestText(url: string, init: RequestInit, opts: HttpOptions = {}): Promise<{ response: Response; text: string }> {
	opts.signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(30000);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	try {
		const response = await (opts.fetchImpl ?? fetch)(url, { ...init, redirect: "error", signal });
		const text = await readLimited(response, signal);
		return { response, text };
	} catch {
		opts.signal?.throwIfAborted();
		if (timeout.aborted) throw new Error("Provider request timed out; the grant may have been consumed. Restart /login if needed.");
		throw new Error("Provider network request failed or returned an invalid/oversized response; the grant may have been consumed.");
	}
}

/** No automatic retry: login grants and exchanges may be single-use. */
export async function requestJson(url: string, init: RequestInit, opts: HttpOptions = {}): Promise<unknown> {
	const { response, text } = await requestText(url, init, opts);
	if (!response.ok) throw new HttpStatusError(response.status);
	try { return JSON.parse(text); }
	catch { throw new Error("Invalid provider JSON response."); }
}

