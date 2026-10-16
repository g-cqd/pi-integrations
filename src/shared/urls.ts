export function safeBaseUrl(value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("Invalid configured API URL."); }
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
		url.username || url.password || url.search || url.hash) throw new Error("Unsafe configured API URL.");
	return url.toString().replace(/\/+$/, "");
}

export function browserUrl(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid browser login URL.");
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("Invalid browser login URL."); }
	if (url.protocol !== "https:" || url.username || url.password) throw new Error("Unsafe browser login URL.");
	return url.toString();
}

/** Restrict returned URLs to a configured HTTPS origin and path boundary. */
export function trustedUrl(value: unknown, base: string): string {
	const url = new URL(browserUrl(value));
	const expected = new URL(base);
	const path = expected.pathname.replace(/\/$/, "");
	if (url.origin !== expected.origin || /%(?:2e|2f|5c)/i.test(url.pathname) ||
		(path && url.pathname !== path && !url.pathname.startsWith(path + "/"))) {
		throw new Error("Invalid sign-in URL origin or path.");
	}
	return url.toString();
}

