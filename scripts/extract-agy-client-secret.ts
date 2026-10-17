/**
 * Recover the Antigravity app's OAuth client secret from an installed `agy`
 * binary and write it to the run-time path this package reads.
 *
 *   bun run agy:extract-secret                 # uses $(command -v agy)
 *   bun run agy:extract-secret -- /path/agy    # explicit binary
 *   bun run agy:extract-secret -- --check      # verify only, write nothing
 *
 * Why this exists instead of a shell one-liner. Google keeps these secrets as
 * adjacent fixed-width strings with no separator, so
 * `strings agy | grep -o 'GOCSPX-[A-Za-z0-9_-]*'` runs two of them together and
 * yields a value that does not exist in the file. A recorded offset is no better:
 * it is valid for exactly one build and moves on the next release. This searches
 * by content, slices each candidate to a plausible length, and accepts nothing
 * the token endpoint has not confirmed.
 *
 * Verification is a real request to Google, so this is deliberately NOT part of
 * `bun test` or `scripts/ci.sh`, matching scripts/verify-pricing.ts. The pure
 * search rules live in scripts/extract/candidates.ts and are unit-tested.
 *
 * The secret is sent only in a POST body (never argv, never a URL), is never
 * printed, and is written mode 600 to a path outside any repository.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findCandidates, defaultSecretPath, TOKEN_ERRORS } from "./extract/candidates.ts";
import { generatePKCE } from "../src/shared/pkce.ts";

/** Pinned by test/agy/oauth.test.ts; the pairing that identifies this app client. */
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const REDIRECT_URI = "https://antigravity.google/oauth-callback";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const binaryPath = args.find((a) => !a.startsWith("--")) ?? whichAgy();

function whichAgy(): string {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		try {
			const candidate = `${dir}/agy`;
			// A directory read throws EISDIR, which is how we reject non-executables.
			if (readFileSync(candidate).length >= 0) return candidate;
		} catch {
			continue;
		}
	}
	return "";
}



/**
 * Ask Google whether this candidate pairs with our client id, using a real PKCE
 * exchange against a deliberately bogus authorization code. A genuine secret
 * produces `invalid_grant` (credentials accepted, code rejected); a wrong or
 * neighbouring value produces `invalid_client`.
 */
async function verify(secret: string): Promise<boolean> {
	const { verifier, challenge } = await generatePKCE();
	const body = new URLSearchParams({
		code: "not-a-real-code",
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		client_secret: secret,
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
			signal: AbortSignal.timeout(20_000),
			redirect: "error",
		});
		const payload: unknown = await response.json();
		const error = typeof payload === "object" && payload !== null ? (payload as { error?: unknown }).error : undefined;
		return error === TOKEN_ERRORS.accepted;
	} catch {
		return false; // transport failure or non-JSON: inconclusive, so discard
	}
}

async function main(): Promise<void> {
	if (!binaryPath) throw new Error("no agy binary found on PATH; pass one as an argument");
	const image = new Uint8Array(readFileSync(binaryPath));
	console.log(`scanning ${binaryPath} (${image.length.toLocaleString()} bytes)`);

	const candidates = findCandidates(image);
	if (candidates.length === 0) throw new Error(`no ${"GOCSPX-"} secret string in ${binaryPath}`);
	console.log(`found ${candidates.length} well-formed candidate(s)`);

	for (const candidate of candidates) {
		if (!(await verify(candidate))) continue;

		// Never print the value; report only its size.
		const path = defaultSecretPath(process.env);
		console.log(`verified a client secret (${candidate.length} bytes)`);
		if (checkOnly) {
			console.log(`--check: nothing written; ${path} would receive it`);
			return;
		}
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		// Create with 600 from the outset rather than widening and narrowing.
		writeFileSync(path, candidate, { mode: 0o600, flag: "w" });
		chmodSync(path, 0o600);
		console.log(`wrote it to\n  ${path}`);
		console.log("It is an app credential of Antigravity, not of any user; keep it out of");
		console.log("shell history, logs, and version control.");
		return;
	}

	throw new Error(
		"no candidate was accepted by the token endpoint; the installed agy may use a rotated or " +
			"different secret. Update agy and re-run rather than configuring a guess.",
	);
}

await main();
