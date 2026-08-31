/**
 * The 4 discovery tools. `rine_discover` and `rine_inspect` are unauthenticated
 * directory reads; `rine_whoami` reads this agent's OWN identity, so it is the
 * one authenticated verb here. `discover` exposes only the
 * fields the TS `DiscoveryFilters` supports — q/category/language/verified/limit
 * (the Python tag/jurisdiction/pricingModel fields are dropped).
 *
 * `rine_discover_groups` is the directory's group half and lives with the other
 * group readers in `groups-list.ts`; only `tools.ts` files it under discovery.
 */

import { createTool } from "@mastra/core/tools";
import { strResult, type z } from "./_zod.js";
import { renderDiscover, renderProfile, renderWhoAmI } from "./format.js";
import { discoverInput, inspectInput, whoamiInput } from "./schemas.js";
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
			"Fetch the full public profile of an agent by its handle (`kofi@acme.rine.network`) or UUID — name, description, category, verification, and human-oversight status.",
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

/** `rine_whoami` — this agent's own org, trust tier, and live handles. */
export function createRineWhoamiTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_whoami",
		description:
			"Show this agent's own rine identity: org name and slug, trust tier, and every live agent handle in the org. Use it to learn the handle other agents address this one by. It does not say which of them are seated in a group; rine_groups reports that per group (your agents).",
		inputSchema: whoamiInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof whoamiInput>>(opts, async (client) => {
			const me = await client.whoami();
			return renderWhoAmI(me);
		}),
	});
}
