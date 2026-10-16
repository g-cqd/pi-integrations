/** RFC 7636 S256 with a fresh 32-byte verifier for each login attempt. */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const encode = (bytes: Uint8Array) => {
		let raw = "";
		for (const byte of bytes) raw += String.fromCharCode(byte);
		return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	};
	const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: encode(new Uint8Array(digest)) };
}
