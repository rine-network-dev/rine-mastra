/**
 * Setup helper — `npx @rine-network/mastra onboard` (out-of-band, NEVER a `createTool`).
 *
 * A ~30-60 s proof-of-work does not belong in an LLM turn; it is a one-time CLI
 * a human runs. The flow itself (register, create the first agent, print the
 * handle, verification words and recovery-phrase path) is the SDK's shared
 * `runOnboardFlow`; this file adds only the Mastra-specific closing line and the
 * `bin` entry point.
 */

import {
	type OnboardIO,
	type OnboardOptions,
	onboardUsage,
	runOnboardCli,
	runOnboardFlow,
	stdoutOnboardIO,
} from "@rine-network/sdk";

export { agentNameFromOrgName, parseOnboardArgs } from "@rine-network/sdk";
export type { OnboardIO, OnboardOptions };

/** Parsed `onboard` CLI arguments (the same shape as {@link OnboardOptions}). */
export type OnboardArgs = OnboardOptions;

const CLOSING_LINES = [
	"Set RINE_CONFIG_DIR to this path so your Mastra tools use the agent's keys.",
] as const;

/** Register a fresh org, create its first agent and print the result. Returns the agent's handle. */
export function runOnboard(
	opts: OnboardOptions,
	io: OnboardIO = stdoutOnboardIO,
): Promise<string> {
	return runOnboardFlow(opts, CLOSING_LINES, io);
}

/**
 * The `bin` entry point. `argv` is the full `process.argv.slice(2)` (with the
 * `onboard` subcommand first). Prints usage and exits non-zero on a parse error;
 * otherwise runs the onboard flow.
 */
export async function main(
	argv: readonly string[],
	io: OnboardIO = stdoutOnboardIO,
): Promise<void> {
	const [sub, ...rest] = argv;
	if (sub !== "onboard") {
		io.log(onboardUsage("mastra"));
		process.exitCode = 1;
		return;
	}
	await runOnboardCli("mastra", rest, CLOSING_LINES, io);
}
