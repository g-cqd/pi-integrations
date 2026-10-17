/**
 * Locating the Antigravity app's OAuth client secret in an installed `agy`
 * binary, and finding the `agy` binary itself.
 *
 * The pure search rules were originally in scripts/extract/candidates.ts and are
 * the single source of truth for both the operator script and the automatic
 * runtime extraction (see requireClientSecret in oauth.ts).
 *
 * Why candidates must be sliced to a length rather than grepped. Google stores
 * these secrets as adjacent fixed-width strings in the binary's string table,
 * with no separator between them. A greedy `GOCSPX-[A-Za-z0-9_-]*` therefore
 * runs two secrets together and returns a value that is not in the file at all.
 * The real secret is 35 bytes; the greedy match is 70 and useless.
 *
 * Nothing here trusts shape. A candidate is only accepted once the token
 * endpoint confirms the pairing (see verifyClientSecret in oauth.ts); the
 * shipped binary is known to contain a decoy `GOCSPX-` string that Google
 * rejects, so candidate order is never a signal.
 */
import { statSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Prefix every Google OAuth client secret carries. */
export const SECRET_PREFIX = "GOCSPX-";

/**
 * Body lengths tried, in bytes after the prefix. Google's Desktop secrets are
 * 35 bytes in total (prefix plus 28). The window is deliberately narrow: wide
 * enough to recover a secret whose length changes in a future app version,
 * narrow enough that a slice running off the end of a real secret is rejected by
 * the character rules rather than reported as a candidate.
 */
export const BODY_LENGTHS = { min: 24, max: 40 } as const;

/** Overrides the binary location for the runtime extraction and the script. */
export const AGY_BINARY_ENV = "AGY_BINARY";

const SHAPE = new RegExp(`^${SECRET_PREFIX}[A-Za-z0-9_-]+$`);

/**
 * Whether a byte slice is a well-formed candidate: the length is inside the
 * plausible window, the prefix is intact, and the rest is only the characters
 * Google uses. The upper bound matters as much as the lower one: without it a
 * slice running off the end of a real secret picks up the next one and is
 * reported as a single oversized candidate, which is the bug this exists to
 * prevent.
 */
export function isCandidate(bytes: Uint8Array): boolean {
	const min = SECRET_PREFIX.length + BODY_LENGTHS.min;
	const max = SECRET_PREFIX.length + BODY_LENGTHS.max;
	if (bytes.length < min || bytes.length > max) return false;
	// Reject early rather than letting TextDecoder insert replacement characters.
	for (const byte of bytes) if (byte < 0x21 || byte > 0x7e) return false;
	return SHAPE.test(new TextDecoder("latin1").decode(bytes));
}

/** Byte offset of every secret prefix in the binary. */
export function findPrefixOffsets(image: Uint8Array): number[] {
	const needle = new TextEncoder().encode(SECRET_PREFIX);
	const offsets: number[] = [];
	outer: for (let i = 0; i + needle.length <= image.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (image[i + j] !== needle[j]) continue outer;
		}
		offsets.push(i);
	}
	return offsets;
}

/**
 * Every distinct well-formed candidate in the image, longest plausible run
 * first for a given offset. Order is not a signal: which candidate is correct
 * is decided by the token endpoint, never by this function.
 */
export function findCandidates(image: Uint8Array): string[] {
	const decoder = new TextDecoder("latin1");
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const offset of findPrefixOffsets(image)) {
		for (let body = BODY_LENGTHS.min; body <= BODY_LENGTHS.max; body++) {
			const total = SECRET_PREFIX.length + body;
			if (offset + total > image.length) continue;
			const slice = image.subarray(offset, offset + total);
			if (!isCandidate(slice)) continue;
			const text = decoder.decode(slice);
			if (seen.has(text)) continue;
			seen.add(text);
			candidates.push(text);
		}
	}
	return candidates;
}

// ---------------------------------------------------------------------------
// Locating the binary
// ---------------------------------------------------------------------------

/**
 * Absolute fallbacks, searched after $PATH. These matter when the host process
 * was not launched from a shell: a GUI-launched Pi does not inherit the user's
 * PATH, so /opt/homebrew/bin can be missing even though `agy` is installed.
 */
export const KNOWN_BINARY_PATHS = [
	"/opt/homebrew/bin/antigravity",
	"/opt/homebrew/bin/agy", // macOS Homebrew (Apple silicon)
	"/usr/local/bin/agy", // macOS Homebrew (Intel prefix) or manual install
	"/usr/local/bin/antigravity", // manual install under the tarball's binary name
	"/usr/bin/antigravity",
	"/usr/bin/agy", // Linux system install
	"~/.local/bin/antigravity",
	"~/.local/bin/agy", // user-local install (expanded)
	"~/bin/agy",
] as const;

/** The tarball ships one binary named `antigravity`; installers alias it to `agy`. */
const BINARY_NAMES = ["agy", "antigravity"] as const;

/** The Homebrew cask keeps its payload under a versioned Caskroom directory. */
const CASKROOM = "/opt/homebrew/Caskroom/antigravity-cli";

const exists = (path: string): boolean => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

const expand = (path: string): string => (path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

/** Scan $PATH for a named executable. Returns the first hit. */
function scanPath(name: string, env: Record<string, string | undefined>, existsFn: (p: string) => boolean): string | undefined {
	for (const dir of (env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsFn(candidate)) return candidate;
	}
	return undefined;
}

/** The Caskroom payload, for cask layouts that keep the binary there. */
function scanCaskroom(existsFn: (p: string) => boolean): string | undefined {
	try {
		for (const version of readdirSync(CASKROOM)) {
			for (const name of BINARY_NAMES) {
				const candidate = join(CASKROOM, version, name);
				if (existsFn(candidate)) return candidate;
			}
		}
	} catch {
		// absent or unreadable: nothing to find
	}
	return undefined;
}

/**
 * Where the `agy` binary lives, or undefined when it is not installed.
 *
 * Search order: an explicit `$AGY_BINARY` override, then `$PATH` (as `agy`,
 * then under its original `antigravity` name), then the absolute fallbacks, then
 * the Homebrew Caskroom. `exists` is injectable so tests never touch the real
 * filesystem.
 */
export function locateAgyBinary(
	env: Record<string, string | undefined> = process.env,
	existsFn: (path: string) => boolean = exists,
): string | undefined {
	const override = env[AGY_BINARY_ENV]?.trim();
	if (override) return override;
	for (const name of BINARY_NAMES) {
		const hit = scanPath(name, env, existsFn);
		if (hit) return hit;
	}
	for (const path of KNOWN_BINARY_PATHS) {
		const expanded = expand(path);
		if (existsFn(expanded)) return expanded;
	}
	return existsFn === exists ? scanCaskroom(existsFn) : undefined;
}

/** Reads the binary. Injectable so tests never read a real 185 MB file. */
export type ReadAgyBinary = (path: string) => Uint8Array;

export const readAgyBinarySync: ReadAgyBinary = (path) => new Uint8Array(readFileSync(path));

/** Every well-formed secret candidate in the installed binary, or [] when absent. */
export function extractBinaryCandidates(
	env: Record<string, string | undefined> = process.env,
	read: ReadAgyBinary = readAgyBinarySync,
	locate: (env: Record<string, string | undefined>) => string | undefined = (e) => locateAgyBinary(e),
): string[] {
	const path = locate(env);
	if (!path) return [];
	try {
		return findCandidates(read(path));
	} catch {
		return []; // unreadable or not a file: same as absent
	}
}
