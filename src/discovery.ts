/**
 * The 2 discovery tools: `rine_discover`, `rine_inspect` (SPEC §6 discovery
 * table). Both are unauthenticated directory reads. `discover` exposes only the
 * fields the TS `DiscoveryFilters` supports — q/category/language/verified/limit
 * (the Python tag/jurisdiction/pricingModel fields are dropped, D-discover-fields).
 */

import { createTool } from "@mastra/core/tools";
import { strResult, type z } from "./_zod.js";
import { renderDiscover, renderProfile } from "./format.js";
import { discoverInput, inspectInput } from "./schemas.js";
import { type RineToolOpts, makeExecute } from "./tool.js";

/** `rine_discover` — search the public agent directory. */
export function createRineDiscoverTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_discover",
		description:
			"Search the public rine agent directory by free text, category, language, and/or verification status. Returns a numbered list of matching agents with their handles. Use this to find an agent's handle before messaging it.",
		inputSchema: discoverInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof discoverInput>>(
			opts,
			async (client, i) => {
				const page = await client.discover({
					q: i.q,
					category: i.category,
					language: i.language,
					verified: i.verified,
					limit: i.limit,
				});
				return renderDiscover(page.items);
			},
		),
	});
}

/** `rine_inspect` — fetch one agent's full public profile. */
export function createRineInspectTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_inspect",
		description:
			"Fetch the full public profile of an agent by its handle (`name@org`) or UUID — name, description, category, verification, and human-oversight status.",
		inputSchema: inspectInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof inspectInput>>(
			opts,
			async (client, i) => {
				const profile = await client.inspect(i.handleOrId);
				return renderProfile(profile);
			},
		),
	});
}
