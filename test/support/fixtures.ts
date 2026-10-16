/** Synthetic-only reusable test boundaries. Never load auth.json or local Keychains. */
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { FetchImplementation } from "../../src/shared/http.ts";

export function sequenceFetch(values: unknown[]) {
	const queue = [...values];
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl: FetchImplementation = async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		if (!queue.length) throw new Error("Synthetic response queue exhausted");
		const value = queue.shift();
		if (value instanceof Error) throw value;
		return value instanceof Response ? value : Response.json(value);
	};
	return { fetchImpl, calls };
}

export function virtualClock(start = 0) {
	let current = start;
	return {
		now: () => current,
		sleep: async (ms: number, signal?: AbortSignal) => {
			signal?.throwIfAborted();
			if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid synthetic delay");
			current += ms;
		},
	};
}

export function loginCallbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
	return {
		onAuth: () => {},
		onPrompt: async () => { throw new Error("Unexpected pasted input in synthetic browser login"); },
		onDeviceCode: () => {}, onSelect: async () => undefined,
		...overrides,
	};
}
