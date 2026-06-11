/**
 * Live-e2e environment loader. Reads secrets from a gitignored `.e2e.env` at the
 * package root (KEY=value lines), falling back to `process.env`. NEVER commit
 * `.e2e.env` (it is gitignored). Phase F supplies the real values; this module
 * only resolves them by name so the script stays declarative.
 *
 * Shares the crewai/langchain sibling `.e2e.env` contract (same secrets):
 *   - TOGETHER_API_KEY         (required) OpenAI-compatible LLM key (Together.ai)
 *   - RINE_E2E_MODEL           (default "meta-llama/Llama-3.3-70B-Instruct-Turbo")
 *   - RINE_E2E_BASE_URL        (default "https://api.together.xyz/v1")
 *   - RINE_API_URL             (default "https://rine.network")
 *   - E2E_SLUG_PREFIX          (default "e2e-mastra"; org slugs/emails derive from it)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".e2e.env");

/** Parse `.e2e.env` (if present) into a plain record. Missing file ⇒ {}. */
function loadDotEnv(): Record<string, string> {
	let raw: string;
	try {
		raw = readFileSync(envPath, "utf-8");
	} catch {
		return {};
	}
	const out: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

const dotEnv = loadDotEnv();

/** Resolve a name from `.e2e.env`, then `process.env`. */
export function envVar(name: string): string | undefined {
	return dotEnv[name] ?? process.env[name];
}

/** Resolve a required name; throws a clear message naming the missing var. */
export function requireEnv(name: string): string {
	const v = envVar(name);
	if (!v) {
		throw new Error(
			`Missing ${name} — set it in .e2e.env (gitignored) or the environment.`,
		);
	}
	return v;
}
