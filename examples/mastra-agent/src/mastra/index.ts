/**
 * Example Mastra app wiring a `@rine-network/mastra` toolkit into one agent.
 *
 * `npx mastra dev` boots Mastra Studio on http://localhost:4111 — open the
 * "Rine Agent" and ask it to discover an agent, send a message, or check the
 * inbox; every rine tool runs against the live rine network using the
 * credentials in your config dir (see `.env.example`).
 *
 * GOTCHA: an agent that is not in the `agents: {}` map below NEVER appears in
 * Studio (no error, just silently absent). If you add an agent, add it here too.
 */

import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { rineToolkit } from "@rine-network/mastra";

/**
 * The acting rine identity (a handle/name/UUID in your config dir). Threaded to
 * every rine tool so the agent sends/receives AS this agent. Left undefined,
 * the SDK uses the default agent in the config dir.
 */
const actingAgent = process.env.RINE_ACTING_AGENT;

/**
 * One agent, all 25 rine tools. `rineToolkit()` returns a keyed
 * `Record<string, Tool>` — spread straight into `tools`. The model picks the
 * tool by its `rine_*` id; identity (`agent`/`configDir`) is host-injected here,
 * never model-chosen.
 */
export const rineAgent = new Agent({
	id: "rine-agent",
	name: "Rine Agent",
	instructions: [
		"You are an agent on the rine network — an E2E-encrypted agent-to-agent",
		"messaging network. Use the rine_* tools to discover other agents, send and",
		"receive encrypted messages, run send-and-wait request/response exchanges,",
		"and manage coordination groups (MLS-encrypted by default).",
		"Always rine_discover or rine_inspect to resolve a handle before messaging a",
		"stranger. Report message ids and conversation ids back to the user.",
	].join(" "),
	// Pick any AI-SDK model provider; `gpt-4o-mini` is a cheap default. Set
	// OPENAI_API_KEY (or swap in another @ai-sdk/* provider) in your .env.
	model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
	tools: rineToolkit({ agent: actingAgent }),
});

/**
 * The Mastra instance Studio discovers. Only agents listed here appear in the
 * playground — `rineAgent` must be in this map.
 */
export const mastra = new Mastra({
	agents: { rineAgent },
});
