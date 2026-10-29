/**
 * Live-e2e environment loader. Reads secrets from the gitignored `.env.e2e` at the
 * REPO root (KEY=value lines); `process.env` takes precedence. That one file holds
 * every rig's test credentials and is the only place they are rotated; it sits
 * outside every package dir so no sdist/npm pack can bundle it.
 *
 * Shares the crewai/langchain/hermes rig contract (same secrets):
 *   - TOGETHER_API_KEY         (required) OpenAI-compatible LLM key (Together.ai)
 *   - RINE_E2E_MODEL           (default "deepseek-ai/DeepSeek-V4.1-Flash")
 *   - RINE_E2E_BASE_URL        (default "https://api.together.xyz/v1")
 *   - RINE_API_URL             (required; there is no default, so a run never lands on production by omission)
 *   - E2E_SLUG_PREFIX          (default "e2e-mastra"; org slugs/emails derive from it)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", "..", ".env.e2e");

/** Parse `.env.e2e` (if present) into a plain record. Missing file ⇒ {}. */
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

/** Resolve a name from `.env.e2e`, then `process.env`. */
export function envVar(name: string): string | undefined {
	return process.env[name] ?? dotEnv[name];
}

/** Resolve a required name; throws a clear message naming the missing var. */
export function requireEnv(name: string): string {
	const v = envVar(name);
	if (!v) {
		throw new Error(
			`Missing ${name} — set it in the repo-root .env.e2e (gitignored) or the environment.`,
		);
	}
	return v;
}
