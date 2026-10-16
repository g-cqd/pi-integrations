/** Cancellable delay; callers may inject a virtual clock/delay for polling tests. */
export async function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
		const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}


export type PollResult<T> = { state: "pending" } | { state: "complete"; value: T };
export interface PollOptions<T> {
	deadline: number;
	intervalMs: number;
	poll: () => Promise<PollResult<T>>;
	signal?: AbortSignal;
	now?: () => number;
	sleep?: typeof waitFor;
	delayFirst?: boolean;
	onPending?: () => void;
}

/** Domain supplies states; this primitive owns timing, cancellation, and late results. */
export async function pollUntil<T>(opts: PollOptions<T>): Promise<T> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? waitFor;
	if (!Number.isFinite(opts.deadline) || !Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) {
		throw new Error("Invalid polling deadline or interval.");
	}
	const check = () => {
		opts.signal?.throwIfAborted();
		if (now() >= opts.deadline) throw new Error("Browser sign-in timed out; restart /login.");
	};
	let delay = opts.delayFirst ?? false;
	while (true) {
		check();
		if (delay) { await sleep(Math.min(opts.intervalMs, opts.deadline - now()), opts.signal); check(); }
		const result = await opts.poll();
		check();
		if (result.state === "complete") return result.value;
		opts.onPending?.();
		delay = true;
	}
}
