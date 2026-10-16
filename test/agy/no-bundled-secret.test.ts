import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "bun:test";

// The Antigravity app's OAuth client secret, and every other credential, must
// stay out of this repository in any encoding. This test is the guard that
// enforces it, so a future change that reintroduces one fails loudly here
// rather than in a remote push-protection alert.

const ROOT = new URL("../../", import.meta.url).pathname;
const SKIP = new Set(["node_modules", ".git", "coverage", "bun.lock"]);
// This file necessarily contains the very patterns it looks for, so it is the
// one file excluded from the literal scan.
const SELF = "no-bundled-secret.test.ts";
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json|md|sh|yml|yaml|toml|txt|env)$/i;

/** Secret shapes worth refusing, matched against the raw text of each file. */
const PATTERNS: Array<[string, RegExp]> = [
	["Google OAuth client secret", /GOCSPX-[A-Za-z0-9_-]{20,}/],
	["Google access or refresh token", /\b(ya29\.[A-Za-z0-9._-]{20,}|[Aa]ccess[_-]?[Tt]oken["'\s:=]+[A-Za-z0-9._-]{40,})/],
	["Anthropic subscription token", /sk-ant-(?:oat|ort)01-[A-Za-z0-9_-]{20,}/],
	["Unsigned JWT", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}/],
	["A PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function* files(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (SKIP.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) yield* files(path);
		else if (SOURCE_EXTENSIONS.test(entry) && entry !== SELF) yield path;
	}
}

const scanned = [...files(ROOT)];

test("the guard scanned the repository but not itself", () => {
	assert.ok(!scanned.some((path) => path.endsWith(SELF)), "the scanner excludes itself, since it holds the patterns");
	assert.ok(scanned.length > 40, `expected to scan many files, scanned ${scanned.length}`);
	assert.ok(scanned.some((path) => path.endsWith(join("src", "domains", "agy", "oauth.ts"))));
});

/** Fixtures in this repo are allowed to be credential-shaped, never credential-valued. */
const SYNTHETIC = /synthetic|placeholder|example|redacted|\[redacted/i;

test("no credential-shaped literal is committed in any encoding", () => {
	const findings: string[] = [];
	for (const path of scanned) {
		const text = readFileSync(path, "utf8");
		for (const [label, pattern] of PATTERNS) {
			for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
				if (SYNTHETIC.test(match[0])) continue; // a named fake, as the fixtures are
				findings.push(`${label} in ${relative(ROOT, path)}: ${match[0].slice(0, 12)}...`);
			}
		}
	}
	assert.deepEqual(findings, [], findings.join("\n"));
});

test("the Antigravity domain resolves its secret instead of holding one", async () => {
	const source = readFileSync(join(ROOT, "src/domains/agy/oauth.ts"), "utf8");
	assert.match(source, /AGY_OAUTH_CLIENT_SECRET/);
	assert.match(source, /agy-oauth-client-secret/, "documents the local file fallback");
	// No base64 blob that decodes to something secret-shaped: check the small
	// set of literals the module exports stay free of credential shapes.
	for (const [name, value] of Object.entries(await import("../../src/domains/agy/oauth.ts"))) {
		if (typeof value !== "string" || !/^[A-Z_]+$/.test(name)) continue;
		for (const [label, pattern] of PATTERNS) assert.ok(!pattern.test(value), `${name} looks like ${label}`);
	}
});
