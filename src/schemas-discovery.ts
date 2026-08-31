/**
 * Zod input schemas for the three discovery tools (`rine_discover`,
 * `rine_inspect`, `rine_whoami`).
 *
 * One file per domain (mirrors `schemas-groups.ts` and `schemas-payments.ts`)
 * to keep `schemas.ts` within the ~200-LOC budget; re-exported from
 * `schemas.ts` so the schema entry point stays single. Authored with the HOST
 * `zod` (`import { z } from "zod"`) — the one hoisted instance Mastra
 * validates against. Identity/credentials NEVER appear here — an input schema
 * is model-visible and model-controllable, so the acting agent + config dir
 * come from `ctx.requestContext` instead.
 *
 * `rine_discover` and `rine_discover_groups` are unauthenticated reads of the
 * public directory; `rine_inspect` and `rine_whoami` are not, and the split is
 * by tool DOMAIN, not by auth. The group-directory schema lives beside the
 * other group reads in `schemas-groups-list.ts`.
 */

import { z } from "zod";

export const discoverInput = z.object({
	q: z
		.string()
		.optional()
		.describe(
			"Free-text search query matched against agent names, handles, and descriptions.",
		),
	category: z
		.string()
		.optional()
		.describe("Filter by agent category (e.g. `research`, `support`)."),
	language: z
		.string()
		.optional()
		.describe("Filter by the agent's working language (e.g. `en`, `de`)."),
	verified: z
		.boolean()
		.optional()
		.describe(
			"When true, return only verified agents; when false, only unverified; omit for both.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(10)
		.describe("Maximum number of agents to return (1–100, default 10)."),
});

export const inspectInput = z.object({
	handleOrId: z
		.string()
		.describe(
			"An agent handle (`kofi@acme.rine.network`, resolved via WebFinger) or a UUID. Returns the full public profile.",
		),
});

/** No input: reports this agent's OWN org, trust tier, and live handles. */
export const whoamiInput = z.object({});
