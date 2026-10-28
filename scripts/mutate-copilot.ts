/** Curated fault-injection campaign, not an exhaustive mutation engine.
 * Runs only synthetic Copilot tests in a disposable source copy; never edits the checkout.
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mutants: Array<[string, string, string, string]> = [
 ["endpoint-domain", "protocol.ts", '!url.hostname.endsWith(".githubcopilot.com")', 'false'],
 ["endpoint-path", "protocol.ts", 'url.pathname !== "/"', 'false'],
 ["refresh-expiry", "oauth.ts", 'expires: now + raw.refresh_in * 1000', 'expires: now'],
 ["device-scope", "oauth.ts", 'scope: "user:email"', 'scope: "repo"'],
 ["refresh-grant", "oauth.ts", 'refresh: githubToken', 'refresh: raw.token'],
 ["disabled-policy", "catalog.ts", 'object(item.policy).state === "disabled"', 'false'],
 ["hidden-model", "catalog.ts", 'item.model_picker_enabled !== true', 'false'],
 ["protocol-priority", "catalog.ts", 'endpoints.includes("/responses")', 'false'],
 ["catalog-pricing", "catalog.ts", 'copilotPrice(item.id)', 'undefined'],
 ["native-dispatch", "provider.ts", 'api: native.api!', 'api: API_ID'],
 ["inference-origin", "provider.ts", 'url.origin !== credential.apiUrl', 'false'],
 ["inference-path", "provider.ts", 'url.pathname !== path', 'false'],
 ["redirect-refusal", "provider.ts", 'redirect: "error"', 'redirect: "follow"'],
 ["cancellation-hang", "provider.ts", "void response.body?.cancel().catch(() => {});", "await response.body?.cancel().catch(() => {});"],
 ["no-replay", "provider.ts", 'maxRetries: 0', 'maxRetries: 2'],
 ["safe-error-headers", "provider.ts", 'headers: safeErrorHeaders(response.headers)', 'headers: response.headers'],
 ["quota-observer", "provider.ts", 'notifyQuota(parseQuotaHeaders(response.headers, (deps.now ?? Date.now)()))', 'undefined'],
 ["agent-initiator", "provider.ts", 'last?.role === "user" ? "user" : "agent"', '"user"'],
 ["quota-remaining", "usage.ts", 'entitlement * (percentRemaining / 100)', 'entitlement * (1 - percentRemaining / 100)'],
 ["quota-invalid", "usage.ts", 'percentRemaining > 100', 'false'],
 ["bar-direction", "usage.ts", '1 - quota.percentRemaining / 100', 'quota.percentRemaining / 100'],
 ["color-exhausted", "usage.ts", 'quota.percentRemaining <= 10', 'quota.percentRemaining < 0'],
 ["color-warning", "usage.ts", 'quota.percentRemaining <= 25', 'quota.percentRemaining <= 5'],
 ["price-promo-expiry", "pricing.ts", 'at >= Date.parse(entry.expires)', 'false'],
 ["price-cache", "pricing.ts", 'now() - checkedAt < DAY', 'false'],
 ["price-failure-retention", "pricing.ts", '} catch {', '} catch { prices = {};'],
 ["price-missing-cell", "pricing-source.ts", 'if (s === undefined) throw new Error("Missing official price cell");', 'if (s === undefined) return 0;'],
 ["status-staleness", "status.ts", 'now() - quota.fetchedAt >= 5 * 60 * 1000', 'false'],
 ["status-model-filter", "status.ts", 'context.model?.provider !== "copilot-vscode"', 'false'],
];
const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "pi-copilot-mutations-"));
try {
 mkdirSync(join(work, "src/domains"), { recursive: true });
 cpSync(join(root, "src/domains/copilot"), join(work, "src/domains/copilot"), { recursive: true });
 cpSync(join(root, "src/shared"), join(work, "src/shared"), { recursive: true });
 cpSync(join(root, "test/copilot"), join(work, "test/copilot"), { recursive: true });
 cpSync(join(root, "test/support"), join(work, "test/support"), { recursive: true });
 cpSync(join(root, "package.json"), join(work, "package.json"));
 symlinkSync(join(root, "node_modules"), join(work, "node_modules"));
 const run = () => Bun.spawnSync([process.execPath, "test", "test/copilot"], { cwd: work, stdout: "pipe", stderr: "pipe", timeout: 30000 });
 const baseline = run();
 if (baseline.exitCode !== 0) throw new Error(`Mutation baseline failed:\n${baseline.stderr.toString()}`);
 const results: Array<{ name: string; result: string }> = [];
 for (const [name, file, before, after] of mutants) {
  const path = join(work, "src/domains/copilot", file), original = readFileSync(path, "utf8");
  if (original.split(before).length !== 2) throw new Error(`Mutation must match exactly once: ${name}`);
  writeFileSync(path, original.replace(before, after));
  const child = run();
  writeFileSync(path, original);
  const output = child.stderr.toString() + child.stdout.toString();
  const result = child.signalCode || /SyntaxError|Cannot find module|Unhandled error between tests/.test(output) ? "invalid" : child.exitCode === 0 ? "survived" : "killed";
  results.push({ name, result }); console.log(`${result.toUpperCase()} ${name}`);
 }
 const killed = results.filter(r => r.result === "killed").length;
 console.log(JSON.stringify({ scope: "curated Copilot fault injections", total: results.length, killed, score: killed / results.length, results }, null, 2));
 if (killed !== results.length) process.exitCode = 1;
} finally { rmSync(work, { recursive: true, force: true }); }
