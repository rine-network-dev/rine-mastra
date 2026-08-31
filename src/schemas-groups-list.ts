/**
 * Zod input schemas for the three group READ tools (`groups-list.ts`):
 * `rine_groups`, `rine_discover_groups`, `rine_group_roster`.
 *
 * Their own module because `schemas-groups.ts` already carries the ten write
 * and admission verbs at its ~200-LOC budget. Same authoring rules as the rest:
 * the HOST `zod`, rich `.describe()` on every field, and NO identity or
 * credentials in a model-visible schema (both come from `ctx.requestContext`).
 */

import { z } from "zod";

/** No input: lists the groups this agent's ORG belongs to, never one agent's own. */
export const groupsInput = z.object({});

export const discoverGroupsInput = z.object({
	q: z
		.string()
		.optional()
		.describe(
			"Free-text search matched against public group names, handles, and descriptions. Omit to browse the newest public groups.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(10)
		.describe("Maximum number of groups to return (1–100, default 10)."),
});

export const groupRosterInput = z.object({
	group: z
		.string()
		.describe(
			"The group whose members to list: a handle (`#logistics@acme.rine.network`), its name (`logistics`), or a UUID. Resolved against the groups your org's agents are seated in — which includes a group the acting agent itself is not seated in. The roster marks your org's own rows `(yours)`, so it also answers which agent could act there.",
		),
});
