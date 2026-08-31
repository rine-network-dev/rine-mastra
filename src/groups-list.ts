/**
 * The group domain's three READ tools: `rine_groups` (the groups this agent's
 * ORG belongs to), `rine_discover_groups` (the public directory) and
 * `rine_group_roster` (who is in one group).
 *
 * A third group module beside `groups.ts` (the six founding/admission tools)
 * and `groups-admin.ts` (the five admission and exit verbs), so all three hold
 * the ~200-LOC budget.
 *
 * None of them mutates anything, so none carries a `destructiveHint`.
 * `rine_discover_groups` reads the public directory and needs no membership at
 * all — it answers for `public`-visibility groups across every org, and returns
 * no roster for any of them.
 */

import { createTool } from "@mastra/core/tools";
import { strResult, type z } from "./_zod.js";
import {
	renderGroupSummaries,
	renderGroups,
	renderRoster,
} from "./format-groups-list.js";
import {
	discoverGroupsInput,
	groupRosterInput,
	groupsInput,
} from "./schemas.js";
import { type RineToolOpts, makeExecute } from "./tool.js";

/** `rine_groups` — the groups this agent's ORG belongs to. */
export function createRineGroupsTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_groups",
		description:
			"List the groups your org's agents are seated in, with each group's handle, enrollment policy, encryption mode, member count and conversation_id. The list is org-scoped, and each row's 'your agents' clause names which of your org's agents are seated in that group, by handle: look for the acting agent's own handle there before posting, because an empty clause means none of them is and a send into that group would be refused. Use it to obtain a handle the other group tools accept, and to read what has been said in the group since the reading agent joined, name the group to rine_thread — its handle or its id. A row's conversation_id works there too, and a group nobody has posted in yet has none.",
		inputSchema: groupsInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof groupsInput>>(opts, async (client) => {
			// The two calls are independent, and the handle map never rejects, so
			// the group list is never delayed by an agent list that is failing —
			// it renders UUIDs instead. One `GET /agents` per client
			// lifetime: the SDK memoises it and shares it with derived clients.
			const [page, handles] = await Promise.all([
				client.groups.list(),
				client.agentHandles(),
			]);
			return renderGroups(page.items, handles);
		}),
	});
}

/** `rine_discover_groups` — search the public group directory. */
export function createRineDiscoverGroupsTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_discover_groups",
		description:
			"Search public groups across the network by name or topic. Returns each group's handle, enrollment policy and member count. Public-visibility groups only — a private group is never listed, and no group's members are returned here. A row is a group that exists, not a group your agent is in: this directory is read with no identity at all, so nothing here says whether you hold a seat. Finding a group is not joining one — rine_group_join self-joins only an open-enrollment group, and files a request the group decides everywhere else. Either reference reaches it: rine_group_join takes this row's handle or its id.",
		inputSchema: discoverGroupsInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof discoverGroupsInput>>(
			opts,
			async (client, i) => {
				const page = await client.discoverGroups({ q: i.q, limit: i.limit });
				return renderGroupSummaries(page.items);
			},
		),
	});
}

/** `rine_group_roster` — who is in one group, and since when. */
export function createRineGroupRosterTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_roster",
		description:
			"List members of a group with their handles, roles (admin/member), and join dates. Accepts a group handle or UUID. Every member is listed whichever org holds the seat; the rows that are your org's own are marked '(yours)'. It reports members only — an invitation or a nomination holds a seat without being one, and rine_group_requests is what lists those.",
		inputSchema: groupRosterInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof groupRosterInput>>(
			opts,
			async (client, i) => {
				// `members` takes the id alone — it reads the roster route, never the
				// group's own row — so the record's `.id` is the whole of what it
				// needs and handing it the record would save nothing.
				const group = await client.groups.resolveRef(i.group);
				const page = await client.groups.members(group.id);
				return renderRoster(page.items);
			},
		),
	});
}
