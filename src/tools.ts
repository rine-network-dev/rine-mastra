/**
 * `rineToolkit(opts)` — the aggregator (SPEC §7). Returns a plain keyed
 * `Record<string, Tool>` (Mastra has no `BaseToolkit` class). The object KEY is
 * the model-facing tool name, so each entry is keyed by its `id`
 * (`toolName === id`). Drop the record straight into a Mastra `Agent`'s
 * `tools: {}` map.
 *
 * `include` curates the surface: `"all"` (12), one domain
 * (`"messaging"`/`"discovery"`/`"groups"`), or an array union of domains.
 *
 * AC-11 shared client: ONE lazily-built `AsyncRineClient` is created per
 * `rineToolkit(...)` call and threaded into every tool's `opts.client`, so all
 * tools share a client (and the warm OAuth token cache). Per-acting-agent
 * variants derive cheaply via `client.withAgent(...)` inside each `execute`.
 *
 * The individual `createRine<X>Tool(opts)` factories are also re-exported for the
 * "attach only what you need" ergonomic.
 */

import type { Tool } from "@mastra/core/tools";
import { getRineClient } from "./client.js";
import { createRineDiscoverTool, createRineInspectTool } from "./discovery.js";
import {
	createRineGroupCreateTool,
	createRineGroupInspectTool,
	createRineGroupInviteTool,
	createRineGroupRemoveTool,
} from "./groups.js";
import {
	createRineCheckInboxTool,
	createRineReadTool,
	createRineReplyTool,
	createRineSendAndWaitTool,
	createRineSendTool,
	createRineThreadTool,
} from "./messaging.js";
import type { RineToolOpts } from "./tool.js";

/** The domains a toolkit can be filtered to. */
export type RineToolDomain = "messaging" | "discovery" | "groups";

/** The tool factories grouped by domain (drives the `include` filter). */
const DOMAINS: Record<
	RineToolDomain,
	readonly ((opts: RineToolOpts) => Tool)[]
> = {
	messaging: [
		createRineSendTool,
		createRineSendAndWaitTool,
		createRineCheckInboxTool,
		createRineReadTool,
		createRineReplyTool,
		createRineThreadTool,
	],
	discovery: [createRineDiscoverTool, createRineInspectTool],
	groups: [
		createRineGroupCreateTool,
		createRineGroupInviteTool,
		createRineGroupRemoveTool,
		createRineGroupInspectTool,
	],
};

const ALL_DOMAINS: readonly RineToolDomain[] = [
	"messaging",
	"discovery",
	"groups",
];

/** Options for {@link rineToolkit}. */
export interface RineToolkitOptions {
	/** Explicit config dir; when omitted, `resolveConfigDir()` is used. */
	configDir?: string;
	/** Explicit API URL; when omitted, `resolveApiUrl()` is used. */
	apiUrl?: string;
	/** Acting agent (handle/name/UUID) sent on every request. */
	agent?: string;
	/** Which tools to include. Default `"all"`. */
	include?: "all" | RineToolDomain | readonly RineToolDomain[];
}

/** Resolve the `include` option to the ordered set of domains to build. */
function resolveDomains(
	include: RineToolkitOptions["include"],
): readonly RineToolDomain[] {
	if (include === undefined || include === "all") return ALL_DOMAINS;
	if (typeof include === "string") return [include];
	// Array union, de-duplicated while preserving the canonical domain order.
	return ALL_DOMAINS.filter((d) => include.includes(d));
}

/**
 * Build the rine tool record. The returned object is keyed by each tool's `id`
 * (so `toolName === id`), ready to spread into a Mastra `Agent`'s `tools` map.
 */
export function rineToolkit(
	opts: RineToolkitOptions = {},
): Record<string, Tool> {
	// ONE shared lazy client per toolkit call (AC-11). `getRineClient` does NOT
	// connect at construction (I-1) — the socket-less client is built here so
	// every tool reuses it and the token cache stays warm.
	const sharedClient = getRineClient({
		configDir: opts.configDir,
		apiUrl: opts.apiUrl,
		agent: opts.agent,
	});
	const toolOpts: RineToolOpts = {
		configDir: opts.configDir,
		apiUrl: opts.apiUrl,
		agent: opts.agent,
		client: sharedClient,
	};

	const out: Record<string, Tool> = {};
	for (const domain of resolveDomains(opts.include)) {
		for (const factory of DOMAINS[domain]) {
			const tool = factory(toolOpts);
			out[tool.id] = tool;
		}
	}
	return out;
}
