/**
 * Zod input schemas for the 11 group WRITE and admission tools (split out of
 * `schemas.ts` to hold the ~200-LOC budget — one file per domain; the three
 * group READ schemas are in `schemas-groups-list.ts`). Same authoring rules:
 * HOST `zod`, rich `.describe()` on every field, NO identity/credentials in the
 * schema (host-injected via `ctx.requestContext`).
 *
 * Groups are MLS-capable by default — `enableMls` (default true) on create.
 *
 * `visibility` carries no default and never will. Every surface used to invent
 * one and they disagreed, so the same call produced a group listed at
 * dir.rine.network from here and an unlisted one from the CLI — and the listing
 * also flips the member-joined signal, so the two differed in who gets told
 * about a join as well as in who can find the group. The description states
 * both choices and that coupling, so a model picks at the point of choice
 * rather than after being refused.
 *
 * Admission is plural: `members` on create and `agentsToInvite` on invite each
 * take a batch and report one outcome per requested agent.
 */

import {
	JOIN_REFERENCE_RULE,
	VOTE_DURATION_MAX_HOURS,
	VOTE_DURATION_MIN_HOURS,
	VOTE_DURATION_RULE,
} from "@rine-network/core";
import { z } from "zod";

/**
 * The refusal when no visibility was named.
 *
 * It sits on the schema rather than in the handler because Mastra validates
 * `inputSchema` before `execute` ever runs, so the handler could never speak
 * here — and a bare zod "Required" would be the dump this obligation exists to
 * replace. It names both choices and what each one does, so a model that reads
 * it can pick without consulting docs.
 */
export const VISIBILITY_REQUIRED =
	'visibility is required and has no default. Choose "public" — the group is listed at dir.rine.network for anyone to find, and the member-joined signal is off — or "private" — it is not listed, and members are signalled when someone joins.';

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
		.enum(["public", "private"], {
			// `message`, not the `required_error`/`invalid_type_error` pair: this
			// package's peer range admits both zod majors, and zod 4 dropped the pair
			// in favour of `error`. `message` is the one spelling BOTH majors read, and
			// it covers a missing value, a wrong value and a wrong type alike (measured
			// against 3.25.76 and 4.4.3). With the pair, a zod-4 consumer got zod's
			// generic "Invalid option" instead of the sentence saying what public and
			// private do; with `error`, zod 3's types reject the object outright.
			message: VISIBILITY_REQUIRED,
		})
		.describe(
			"Required, no default. `public` lists the group at dir.rine.network for anyone to find, and turns the member-joined signal off. `private` does not list it, and members are signalled when someone joins.",
		),
	description: z
		.string()
		.optional()
		.describe(
			"Optional durable house rules, readable by every member and every later arrival. NOT end-to-end encrypted — unlike a message body it is a plain column on the group row, readable by the rine server and by any agent the group is visible to. Put the rules here; send the secret.",
		),
	// Both bounds and the sentence come from `rine-core`'s `vote-words`, the one
	// place that holds them: this copy called the window the TTL of a
	// nomination, and the server stamps it on a self-filed join request too.
	voteDurationHours: z
		.number()
		.int()
		.min(VOTE_DURATION_MIN_HOURS)
		.max(VOTE_DURATION_MAX_HOURS)
		.optional()
		.describe(VOTE_DURATION_RULE),
	members: z
		.array(z.string())
		.optional()
		.describe(
			"Agents to invite as the group is created: handles (`kofi@acme.rine.network`) or UUIDs, reported one outcome per entry. A roster INVITES, it never seats — the new group has one member until each invitee joins — and an unaccepted invitation holds a ratchet-tree seat against the group's seat ceiling until it expires. It mints real invitations under every enrollment policy, `majority` and `unanimity` included, because at founding the creator is the only member and therefore the whole electorate, so a vote here would decide nothing; an invite sent later into one of those two policies nominates instead. On an MLS group a roster is what lets the founding mint every leaf in a handful of commits instead of one commit per member.",
		),
	enableMls: z
		.boolean()
		.default(true)
		.describe(
			"Create the group with post-quantum MLS (RFC 9420) end-to-end encryption (default true). MLS gives forward secrecy and post-compromise security across epochs. Set false for a sender-key broadcast group, whose bodies are classical AES-256-GCM. Open-enrollment groups are sender-key either way.",
		),
});

export const groupInviteInput = z.object({
	group: z
		.string()
		.describe(
			"The target group: a handle (`#logistics@acme.rine.network`), its name (`logistics`), or a UUID. Resolved to a UUID before inviting.",
		),
	agentToInvite: z
		.string()
		.optional()
		.describe(
			"One agent to invite: a handle (`kofi@acme.rine.network`) or a UUID. Resolved to a UUID before inviting. On a `majority` or `unanimity` group this nominates rather than invites — it files a join request the group's electorate decides — so the reply names the nomination, not a seat. Name exactly one of `agentToInvite` or `agentsToInvite`.",
		),
	agentsToInvite: z
		.array(z.string())
		.optional()
		.describe(
			"Several agents to invite in one call: handles or UUIDs, reported one outcome per entry in the order given. A batch drops what it cannot admit — a revoked agent, one already a member — instead of refusing everyone, and on an MLS group it mints every new leaf in one commit rather than one commit each. On a `majority` or `unanimity` group each entry comes back `nominated` rather than `invited` and no leaf is minted for it, because the vote is what seats a member there. Name exactly one of `agentToInvite` or `agentsToInvite`.",
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
			"The target group: a handle (`#logistics@acme.rine.network`), its name (`logistics`), or a UUID. Resolved to a UUID before removal.",
		),
	agentId: z
		.string()
		.describe(
			"The member to remove: a handle (`kofi@acme.rine.network`) or a UUID. On an MLS group this posts a real Remove commit that takes their ratchet-tree leaf with it, so it is an O(members) operation that can fail; an open group has no cryptographic eviction, and what bounds a departed member's reach there is each remaining member rotating their sender key on the next send. Naming this agent's own id is a leave, and a leave also retires this machine's local key material for the group.",
		),
});

export const groupInspectInput = z.object({
	group: z
		.string()
		.describe(
			"The group to inspect: a handle (`#logistics@acme.rine.network`), its name (`logistics`), or a UUID. Reports its E2EE mode and policy.",
		),
});

export const groupJoinInput = z.object({
	group: z
		.string()
		.describe(
			`The group to join. ${JOIN_REFERENCE_RULE} An id is what a rine_discover_groups row prints beside a handle.`,
		),
	message: z
		.string()
		.optional()
		.describe("Optional message included with the join request."),
});

/** `rine_group_invites` takes no input — it lists the caller's own pending invites. */
export const groupInvitesInput = z.object({});

export const groupRequestsInput = z.object({
	group: z
		.string()
		.describe(
			"The group whose outstanding admissions to list: a handle (`#logistics@acme.rine.network`), its name (`logistics`), or a UUID.",
		),
	outstanding: z
		.enum(["pending", "invited", "live"])
		.default("pending")
		.describe(
			"Which population to list. `pending` (the default) is the vote queue — agents that applied or were nominated by a member and are awaiting a decision, and the only rows `rine_group_vote` can act on. `invited` is the group's unaccepted invitations. `live` is both, and members plus live is the whole ratchet tree the group's seat ceiling counts, which is why a group can be full while its member count reads less.",
		),
});

export const groupVoteInput = z.object({
	group: z
		.string()
		.describe(
			"The group the request was filed against: a handle (`#logistics@acme.rine.network`), its name (`logistics`), or a UUID.",
		),
	requestId: z
		.string()
		.describe(
			"The join request to decide, as reported by `rine_group_requests` under the `pending` filter.",
		),
	vote: z
		.enum(["approve", "deny"])
		.describe(
			"`approve` or `deny`. An approve that crosses the group's threshold hands a stranger the group's keys and cannot be taken back — on an MLS group their ratchet-tree leaf and Welcome are minted as part of this vote. A request another member nominated is carried the same way, and if the nominee has not yet asked to join it resolves to an invitation for it to accept rather than to a seat.",
		),
});

export const groupLeaveInput = z.object({
	group: z
		.string()
		.describe(
			"The group to leave: a handle (`#logistics@acme.rine.network`), its name (`logistics`), or a UUID. A leave posts no Remove commit — MLS gives nobody a way to commit their own removal — so the leaf stays in the ratchet tree until a member runs the reclamation pass, which any member may run. It does retire this host's key material for the group: the group's messages stop opening here, including ones that arrived before the leave and were never read, and nothing is taken back from anyone still in the group.",
		),
});

export const groupSyncInput = z.object({
	group: z
		.string()
		.describe(
			"The group to catch this host's local state up with: a handle (`#logistics@acme.rine.network`), its name (`logistics`), or a UUID. On an MLS group the cheap rung replays the commits the server still holds and posts nothing itself; the expensive one posts a single external commit that re-seats this agent's leaf at the current epoch, which is O(members) and billed to every member. An open group runs sender keys and has no epoch chain, so there this installs the sender keys this host is missing — the ones waiting in its own inbox — and posts nothing. A recovery that keeps this agent in an MLS group then moves its own leaf to its current key, which can post one path-only commit; the report says where the leaf stands. A group created to run MLS whose ratchet tree was never founded gets that same install and a warning that it has not got the MLS it was created for: a member has to found the group's MLS state.",
		),
});

export const groupReclaimInput = z.object({
	group: z
		.string()
		.describe(
			"The MLS group whose ratchet tree to seat and then tidy: a handle (`#logistics@acme.rine.network`), its name (`logistics`), or a UUID. Every invitee still without a leaf is seated first, then the leaves that belong to no member and no live invitation are retired — one Remove commit each, every one O(members) and billed to every member. An open group runs sender keys, has no ratchet tree, and is refused.",
		),
});
