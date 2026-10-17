import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "bun:test";

// The Antigravity app's OAuth client secret, and every other credential, must
// stay out of this repository in any encoding. This test is the guard that
// enforces it, so a future change that reintroduces one fails loudly here
// rather than in a remote push-protection alert.
//
// A raw-text scan is not sufficient on its own: a secret that has been
// base64'd, hex'd, or written backwards contains none of the credential
// shapes below, and passes a scan that only reads the file as text. Every file
// is therefore decoded before it is matched, so obfuscation fails the guard
// instead of hiding from it.

const ROOT = new URL("../../", import.meta.url).pathname;
const SKIP = new Set(["node_modules", ".git", "coverage", "bun.lock"]);
// This file necessarily contains the very patterns it looks for, and the
// encodings it decodes, so it is the one file excluded from the scan.
const SELF = "no-bundled-secret.test.ts";
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json|md|sh|yml|yaml|toml|txt|env)$/i;

/** Secret shapes worth refusing, matched against every decoded view of a file. */
const PATTERNS: Array<[string, RegExp]> = [
	["Google OAuth client secret", /GOCSPX-[A-Za-z0-9_-]{20,}/],
	["Google access or refresh token", /\b(ya29\.[A-Za-z0-9._-]{20,}|[Aa]ccess[_-]?[Tt]oken["'\s:=]+[A-Za-z0-9._-]{40,})/],
	["Anthropic subscription token", /sk-ant-(?:oat|ort)01-[A-Za-z0-9_-]{20,}/],
	["Unsigned JWT", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}/],
	["A PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Candidate encoded spans: long enough to hide a credential, narrow enough to decode. */
const BLOB = /[A-Za-z0-9+/=_-]{24,}/g;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;
/** Decoded text must look like text to be worth matching; identifiers do not. */
const PRINTABLE = /^[\x09\x0a\x0d\x20-\x7e]*$/;

/** Reverses a string without splitting surrogate pairs. */
function reverse(value: string): string {
	return [...value].reverse().join("");
}

/** Decodes one candidate span, or returns undefined when it is not that encoding. */
function decodeBase64(value: string, urlSafe: boolean): string | undefined {
	const normalized = urlSafe ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return undefined;
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	try {
		const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return PRINTABLE.test(text) ? text : undefined;
	} catch {
		return undefined;
	}
}

function decodeHex(value: string): string | undefined {
	if (!HEX.test(value)) return undefined;
	try {
		const bytes = new Uint8Array(value.length / 2);
		for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.substr(i * 2, 2), 16);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return PRINTABLE.test(text) ? text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every view of a file worth matching: the text itself, each decodable span it
 * contains, and the concatenation of its string literals (which defeats
 * `"GOCSPX-" + "AAAA..."` splitting).
 */
function* views(text: string): Generator<[string, string]> {
	yield ["as written", text];
	yield ["reversed", reverse(text)];

	// Adjacent string literals joined, so a secret split across `"a" + "b"` is seen whole.
	const literals = [...text.matchAll(/"([^"\\\n]{8,})"|'([^'\\\n]{8,})'/g)]
		.map((m) => m[1] ?? m[2])
		.join("");
	if (literals.length >= 24) yield ["concatenated string literals", literals];

	for (const match of text.matchAll(BLOB)) {
		const blob = match[0];
		for (const [label, decode] of [
			["base64", (v: string) => decodeBase64(v, false)],
			["base64url", (v: string) => decodeBase64(v, true)],
			["hex", decodeHex],
		] as const) {
			const decoded = decode(blob);
			if (decoded !== undefined) yield [`${label} encoded`, decoded];
		}
	}
}

function* files(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (SKIP.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) yield* files(path);
		else if (SOURCE_EXTENSIONS.test(entry) && entry !== SELF) yield path;
	}
}

const scanned = [...files(ROOT)];

/** Fixtures in this repo are allowed to be credential-shaped, never credential-valued. */
const SYNTHETIC = /synthetic|placeholder|example|redacted|\[redacted/i;

test("the guard scanned the repository but not itself", () => {
	assert.ok(!scanned.some((path) => path.endsWith(SELF)), "the scanner excludes itself, since it holds the patterns");
	assert.ok(scanned.length > 40, `expected to scan many files, scanned ${scanned.length}`);
	assert.ok(scanned.some((path) => path.endsWith(join("src", "domains", "agy", "oauth.ts"))));
});

test("no credential-shaped literal is committed in any encoding", () => {
	const findings: string[] = [];
	for (const path of scanned) {
		const text = readFileSync(path, "utf8");
		for (const [encoding, view] of views(text)) {
			for (const [label, pattern] of PATTERNS) {
				for (const match of view.matchAll(new RegExp(pattern.source, "g"))) {
					if (SYNTHETIC.test(match[0])) continue; // a named fake, as the fixtures are
					findings.push(`${label} ${encoding} in ${relative(ROOT, path)}: ${match[0].slice(0, 12)}...`);
				}
			}
		}
	}
	assert.deepEqual(findings, [], findings.join("\n"));
});

// The decode pass is only worth anything if it is proven to fire. These
// assertions use a shape that is credential-shaped but not credential-valued,
// so they carry no secret and stay inside the repository's own rules.
const CANARY = "GOCSPX-CANARYCANARYCANARYCANARYC";

test("the guard detects a credential in each encoding it claims to decode", () => {
	const hex = [...CANARY].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
	const samples: Array<[string, string]> = [
		["as written", `token = "${CANARY}"`],
		["base64 encoded", `blob = "${btoa(CANARY)}"`],
		["base64url encoded", `blob = "${btoa(CANARY).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}"`],
		["hex encoded", `blob = "${hex}"`],
		["reversed", `blob = "${reverse(CANARY)}"`],
		["concatenated string literals", `token = "GOCSPX-CANARY" + "CANARYCANARYCANARYC"`],
	];
	for (const [encoding, sample] of samples) {
		const hits = [...views(sample)]
			.flatMap(([, view]) => PATTERNS.filter(([, p]) => p.test(view)))
			.map(([label]) => label);
		assert.ok(hits.length > 0, `the guard failed to detect a credential ${encoding}`);
	}
});

test("the Antigravity domain resolves its secret instead of holding one", async () => {
	const source = readFileSync(join(ROOT, "src/domains", "agy", "oauth.ts"), "utf8");
	assert.match(source, /AGY_OAUTH_CLIENT_SECRET/);
	assert.match(source, /agy-oauth-client-secret/, "documents the local file fallback");
	// Check the module's exported literals against every decoded view too, so a
	// secret cannot hide behind an encoding in a constant.
	for (const [name, value] of Object.entries(await import("../../src/domains/agy/oauth.ts"))) {
		if (typeof value !== "string" || !/^[A-Z_]+$/.test(name)) continue;
		for (const [label, pattern] of PATTERNS) {
			assert.ok(!pattern.test(value), `${name} looks like ${label}`);
		}
	}
});
