/**
 * One-shot OAuth loopback callback server for browser sign-in.
 *
 * The provider redirects the browser to http://localhost:<port><path> with
 * `code` and `state`. Rules, each covered by tests:
 *   - only GET on the exact path is served; everything else is 404;
 *   - the Host header must name the loopback origin we bound (DNS-rebinding guard);
 *   - a callback with the wrong or missing `state` is rejected and IGNORED:
 *     it does not settle the flow, so stray requests cannot cancel a real login;
 *   - a provider `error` rejects the flow with an allowlisted code only;
 *   - the first valid callback wins; the server stops accepting after that;
 *   - served pages are static strings and never reflect query content.
 * Binding fails with the underlying error (EADDRINUSE etc.) so callers can fall
 * back to a pasted redirect URL.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackOptions {
	/** Interface to bind. Default 127.0.0.1. */
	host?: string;
	/** Port to bind; 0 picks a free port (tests only; real redirect URIs are fixed). */
	port: number;
	/** Exact callback path, for example "/auth/callback". */
	path: string;
	/** The state value this login generated. */
	state: string;
	signal?: AbortSignal;
	/** Query parameter carrying the code. Default "code". */
	codeParam?: string;
}

export interface LoopbackServer {
	/** The bound port (useful when `port: 0` was requested). */
	readonly port: number;
	/** Resolves with the authorization code from the first valid callback. */
	readonly result: Promise<string>;
	close(): void;
}

const PAGE_OK = "<!doctype html><meta charset=utf-8><title>Signed in</title><p>Sign-in complete. You can close this window and return to Pi.</p>";
const PAGE_ERROR = "<!doctype html><meta charset=utf-8><title>Sign-in failed</title><p>Sign-in could not be completed. Return to Pi and try again.</p>";
const SAFE_ERROR_CODE = /^[a-z_]{1,64}$/;

function hostAllowed(header: string | undefined, port: number): boolean {
	if (!header) return false;
	return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(header.toLowerCase());
}

export function startLoopback(options: LoopbackOptions): Promise<LoopbackServer> {
	const host = options.host ?? "127.0.0.1";
	const codeParam = options.codeParam ?? "code";
	return new Promise((resolveStart, rejectStart) => {
		let settled = false;
		let resolveResult!: (code: string) => void;
		let rejectResult!: (error: Error) => void;
		const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
		result.catch(() => {}); // callers attach their own handler; never leave an unhandled rejection
		let boundPort = options.port;

		const server: Server = createServer((request, response) => {
			const reply = (status: number, body: string) => {
				response.writeHead(status, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
					"X-Content-Type-Options": "nosniff",
				});
				response.end(body);
			};
			if (request.method !== "GET" || !hostAllowed(request.headers.host, boundPort)) return reply(404, PAGE_ERROR);
			let url: URL;
			try { url = new URL(request.url ?? "", `http://localhost:${boundPort}`); } catch { return reply(400, PAGE_ERROR); }
			if (url.pathname !== options.path) return reply(404, PAGE_ERROR);
			if (settled) return reply(409, PAGE_ERROR);

			const error = url.searchParams.get("error");
			if (error !== null) {
				if (url.searchParams.get("state") !== options.state) return reply(400, PAGE_ERROR);
				settled = true;
				reply(400, PAGE_ERROR);
				rejectResult(new Error(`Authorization was not completed (${SAFE_ERROR_CODE.test(error) ? error : "error"}). Restart /login.`));
				return close();
			}
			const code = url.searchParams.get(codeParam);
			if (!code || url.searchParams.get("state") !== options.state) return reply(400, PAGE_ERROR);
			settled = true;
			reply(200, PAGE_OK);
			resolveResult(code);
			close();
		});

		const onAbort = () => {
			if (!settled) { settled = true; rejectResult(options.signal?.reason ?? new Error("Login cancelled")); }
			close();
		};
		function close() {
			options.signal?.removeEventListener("abort", onAbort);
			server.close();
			server.closeAllConnections?.();
		}

		server.once("error", (error) => {
			if (!settled) { settled = true; rejectResult(error); }
			rejectStart(error);
		});
		server.listen(options.port, host, () => {
			boundPort = (server.address() as AddressInfo).port;
			if (options.signal?.aborted) onAbort();
			else options.signal?.addEventListener("abort", onAbort, { once: true });
			resolveStart({ port: boundPort, result, close });
		});
	});
}

export type AuthorizationInput =
	| { type: "callback"; code: string }
	| { type: "manual"; input: string };

/**
 * Wait for whichever arrives first: the loopback callback or a manual paste.
 * With a loopback and no manual source, only the callback can complete the flow.
 * With no loopback (port busy), the manual source is required.
 */
export async function awaitAuthorizationInput(args: {
	loopback?: LoopbackServer;
	manual?: () => Promise<string>;
}): Promise<AuthorizationInput> {
	const racers: Array<Promise<AuthorizationInput>> = [];
	if (args.loopback) racers.push(args.loopback.result.then((code) => ({ type: "callback" as const, code })));
	if (args.manual) racers.push(args.manual().then((input) => ({ type: "manual" as const, input })));
	if (racers.length === 0) throw new Error("No way to receive the authorization response.");
	return Promise.race(racers);
}
