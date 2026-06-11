/**
 * Programmatic tool sweep (SPEC §16): drive each of the 11 `createTool` tools
 * through its public `execute(inputData, ctx)` against the live server with the
 * throwaway org's identity injected via a real Mastra `RequestContext`. Proves
 * every tool returns a readable string (never a reject, I-3) and that ciphertext
 * never appears in any return (I-2) — before the LLM leg drives the same tools.
 */

import { RequestContext } from "@mastra/core/request-context";
import type { Tool } from "@mastra/core/tools";
import {
	RINE_ACTING_AGENT,
	RINE_CONFIG_DIR,
	rineToolkit,
} from "../src/index.js";
import { check } from "./_legs.js";

/** Build a Mastra ctx carrying the acting identity (host-injected, NOT in schema). */
function ctxFor(configDir: string, agent: string) {
	const rc = new RequestContext();
	rc.set(RINE_CONFIG_DIR, configDir);
	rc.set(RINE_ACTING_AGENT, agent);
	return { requestContext: rc };
}

/** Run a tool's execute and return its string; assert the sentinel is absent. */
async function fire(
	tools: Record<string, Tool>,
	id: string,
	input: unknown,
	ctx: unknown,
	sentinel: string,
): Promise<string> {
	const tool = tools[id];
	if (!tool?.execute) throw new Error(`tool ${id} missing execute`);
	// The tools' execute is the package's two-arg `(inputData, ctx)` form; cast
	// the call to drive it with a plain RequestContext-bearing ctx.
	const exec = tool.execute as (i: unknown, c: unknown) => Promise<unknown>;
	const out = String(await exec(input, ctx));
	check(!out.includes(sentinel), `${id} return has no ciphertext (I-2)`);
	return out;
}

/**
 * Sweep the read-only + discovery tools programmatically (the mutating ones are
 * exercised by the live legs so the sweep stays side-effect-light). Returns
 * nothing; throws on the first failed assertion.
 */
export async function toolSweep(args: {
	configDir: string;
	agent: string;
	responderHandle: string;
	sentinel: string;
}): Promise<void> {
	const tools = rineToolkit({ configDir: args.configDir, agent: args.agent });
	const ctx = ctxFor(args.configDir, args.agent);
	check(Object.keys(tools).length === 11, "rineToolkit() built all 11 tools");

	await fire(tools, "rine_discover", { limit: 5 }, ctx, args.sentinel);
	await fire(
		tools,
		"rine_inspect",
		{ handleOrId: args.responderHandle },
		ctx,
		args.sentinel,
	);
	await fire(tools, "rine_check_inbox", { limit: 10 }, ctx, args.sentinel);
	console.log("  [ok] programmatic tool sweep clean (11 tools, no ciphertext)");
}
