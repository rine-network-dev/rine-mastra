/**
 * Zod input schemas for the 4 group tools (split out of `schemas.ts` to hold the
 * ~200-LOC budget — the schema concentration the SPEC §4 endorses, one file per
 * domain). Same authoring rules: HOST `zod`, rich `.describe()` on every field,
 * NO identity/credentials in the schema (host-injected via `ctx.requestContext`).
 *
 * Groups are MLS-capable by default — `enableMls` (default true) on create is the
 * headline inversion vs the Python siblings (D-mls).
 */

import { z } from "zod";

export const groupCreateInput = z.object({
	name: z
		.string()
		.describe("Human-readable group name. A group handle is derived from it."),
	enrollment: z
		.enum(["open", "closed", "majority", "unanimity"])
		.default("closed")
		.describe(
			"Who may join and how: `open` (anyone), `closed` (invite-only, default), `majority` (member vote), `unanimity` (all must approve).",
		),
	visibility: z
		.enum(["public", "private"])
		.default("private")
		.describe("`public` (listed in discovery) or `private` (hidden, default)."),
	description: z.string().optional().describe("Optional group description."),
	enableMls: z
		.boolean()
		.default(true)
		.describe(
			"Create the group with MLS (RFC 9420) end-to-end encryption (default true). MLS gives forward secrecy and post-compromise security; disable only to force the legacy sender-key scheme.",
		),
});

export const groupInviteInput = z.object({
	group: z
		.string()
		.describe(
			"The target group: a handle (`#name@org`) or a UUID. Resolved to a UUID before inviting.",
		),
	agentToInvite: z
		.string()
		.describe(
			"The agent to invite: a handle (`name@org`) or a UUID. Resolved to a UUID before inviting.",
		),
	message: z
		.string()
		.optional()
		.describe("Optional message included with the invite."),
});

export const groupRemoveInput = z.object({
	group: z
		.string()
		.describe(
			"The target group: a handle (`#name@org`) or a UUID. Resolved to a UUID before removal.",
		),
	agentId: z
		.string()
		.describe(
			"The member to remove: a handle (`name@org`) or a UUID. Group keys are rotated after removal.",
		),
});

export const groupInspectInput = z.object({
	group: z
		.string()
		.describe(
			"The group to inspect: a handle (`#name@org`) or a UUID. Reports its E2EE mode and policy.",
		),
});
