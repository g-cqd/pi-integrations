import assert from "node:assert/strict";
import { test } from "bun:test";
import { iterateSse, type SseEvent } from "../../src/shared/index.ts";

const enc = new TextEncoder();
function bodyOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i >= chunks.length) return controller.close();
			const chunk = chunks[i++];
			controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
		},
	});
}
async function collect(body: ReadableStream<Uint8Array>, signal?: AbortSignal, max?: number): Promise<SseEvent[]> {
	const out: SseEvent[] = [];
	for await (const event of iterateSse(body, signal, max)) out.push(event);
	return out;
}

test("parses events, names, comments, and multi-line data", async () => {
	const events = await collect(bodyOf([
		": keep-alive comment\n\nevent: ping\ndata: one\n\ndata: a\ndata: b\n\nretry: 100\n\ndata:no-space\n\n",
	]));
	assert.deepEqual(events, [{ event: "ping", data: "one" }, { data: "a\nb" }, { data: "no-space" }]);
});

test("all three line endings are accepted, including mixed", async () => {
	for (const text of ["data: x\r\n\r\ndata: y\r\n\r\n", "data: x\n\ndata: y\n\n", "data: x\r\rdata: y\r\r", "data: x\r\n\ndata: y\n\r\n"]) {
		assert.deepEqual((await collect(bodyOf([text]))).map((e) => e.data), ["x", "y"], JSON.stringify(text));
	}
});

test("a CRLF split across chunks is one line break, not two", async () => {
	const events = await collect(bodyOf(["data: x\r", "\ndata: y\r", "\n\r", "\n"]));
	assert.deepEqual(events.map((e) => e.data), ["x\ny"], "the blank line only arrives with the final CRLF");
});

test("any chunking of the same stream yields the same events", async () => {
	const text = "event: a\ndata: {\"k\":1}\n\ndata: second\ndata: line\n\n: c\n\ndata: last\n\n";
	const whole = await collect(bodyOf([text]));
	for (let size = 1; size <= 7; size++) {
		const chunks: string[] = [];
		for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
		assert.deepEqual(await collect(bodyOf(chunks)), whole, `chunk size ${size}`);
	}
});

test("a multi-byte character split across chunks decodes intact", async () => {
	const bytes = enc.encode("data: caf\u00e9 \u{1F600}\n\n");
	for (let cut = 1; cut < bytes.length; cut++) {
		const events = await collect(bodyOf([bytes.slice(0, cut), bytes.slice(cut)]));
		assert.deepEqual(events.map((e) => e.data), ["caf\u00e9 \u{1F600}"], `cut at ${cut}`);
	}
});

test("a leading BOM is ignored and a final unterminated event is still delivered", async () => {
	assert.deepEqual((await collect(bodyOf(["\uFEFFdata: first\n\ndata: tail"]))).map((e) => e.data), ["first", "tail"]);
});

test("events with no data are dropped", async () => {
	assert.deepEqual(await collect(bodyOf(["event: only-name\n\n\n\n"])), []);
});

test("an event larger than the limit is rejected, whether one line or many", async () => {
	await assert.rejects(collect(bodyOf(["data: " + "x".repeat(200) + "\n\n"]), undefined, 100), /too large/);
	await assert.rejects(collect(bodyOf([Array.from({ length: 20 }, () => "data: " + "y".repeat(20)).join("\n") + "\n\n"]), undefined, 100), /too large/);
	await assert.rejects(collect(bodyOf(["z".repeat(500)]), undefined, 100), /too large/, "no newline at all");
});

test("invalid UTF-8 is an error, not silent replacement", async () => {
	await assert.rejects(collect(bodyOf([new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0xfe, 0x0a, 0x0a])])));
});

test("abort stops iteration and cancels the underlying reader", async () => {
	let cancelled = false;
	const controller = new AbortController();
	const body = new ReadableStream<Uint8Array>({
		pull(c) { c.enqueue(enc.encode("data: x\n\n")); },
		cancel() { cancelled = true; },
	});
	await assert.rejects((async () => {
		for await (const _ of iterateSse(body, controller.signal)) controller.abort();
	})(), { name: "AbortError" });
	assert.equal(cancelled, true);
});

test("breaking out early releases the stream", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(c) { c.enqueue(enc.encode("data: x\n\n")); },
		cancel() { cancelled = true; },
	});
	for await (const _ of iterateSse(body)) break;
	assert.equal(cancelled, true);
});

test("abort interrupts a read that would otherwise wait forever, even if the transport ignores the signal", async () => {
	const controller = new AbortController();
	let cancelled = false;
	const silent = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } });
	setTimeout(() => controller.abort(), 10);
	await assert.rejects((async () => { for await (const _ of iterateSse(silent, controller.signal)) { /* never yields */ } })(), { name: "AbortError" });
	assert.equal(cancelled, true);
});

test("an already-aborted signal rejects before reading", async () => {
	const controller = new AbortController(); controller.abort();
	await assert.rejects((async () => { for await (const _ of iterateSse(bodyOf(["data: x\n\n"]), controller.signal)) { /* none */ } })(), { name: "AbortError" });
});
