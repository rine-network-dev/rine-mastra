/**
 * The 5 admission + membership-exit group tools: `rine_group_requests`,
 * `rine_group_vote`, `rine_group_leave`, `rine_group_sync`,
 * `rine_group_reclaim`.
 *
 * Split from `groups.ts` (which holds the six create/invite/inspect/join tools)
 * so both files stay inside the ~200-LOC budget. Same idiom: one exported
 * factory per tool, the SDK does the work, the tool renders.
 *
 * `rine_group_leave` is a distinct tool rather than a mode of
 * `rine_group_remove`, which keeps its own "name your own agent to leave"
 * behaviour: a leave destroys THIS host's key material, a removal acts on a
 * third party, and one wrong argument should not turn one into the other.
 */

import { createTool } from "@mastra/core/tools";
import { VOTE_ELECTORATE_RULE, describeMlsRecovery } from "@rine-network/core";
import { type z, strResult } from "./_zod.js";
import {
	renderReclamation,
	renderRequests,
	renderVote,
	renderVoteRefusal,
} from "./format-groups.js";
import {
	groupLeaveInput,
	groupReclaimInput,
	groupRequestsInput,
	groupSyncInput,
	groupVoteInput,
} from "./schemas.js";
import { type RineToolOpts, makeExecute } from "./tool.js";

/** `rine_group_requests` — list a group's outstanding admissions. */
export function createRineGroupRequestsTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_requests",
		description:
			"List a group's outstanding admissions. `pending` (the default) is the vote queue — the applicants and nominees awaiting a decision, and the only rows rine_group_vote can act on. `invited` is the group's unaccepted invitations. `live` is both: members plus live is the whole ratchet tree the group's seat ceiling counts, which is why a group can be full while its member count reads less. Read-only. Each row names the request id, the applicant, the status, both bars — the approvals counted with how many more are needed, and the denials counted with how many more would refuse it — this agent's own standing, and when the row lapses. A row a member nominated is born carrying that member's approval, so `1 approved` on a fresh request is ordinary rather than a sign somebody has already voted on it twice.",
		inputSchema: groupRequestsInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof groupRequestsInput>>(
			opts,
			async (client, i) => {
				// `listRequests` takes the id alone — the requests route reads no
				// group row — so the record's `.id` is all it needs.
				const group = await client.groups.resolveRef(i.group);
				const rows = await client.groups.listRequests(group.id, {
					outstanding: i.outstanding,
				});
				return renderRequests(i.group, i.outstanding, rows);
			},
		),
	});
}

/** `rine_group_vote` — approve or deny one pending join request. */
export function createRineGroupVoteTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_vote",
		description: `Approve or deny a pending join request in a group your agent belongs to; vote on the requests rine_group_requests lists. ${VOTE_ELECTORATE_RULE} An approve that crosses the threshold hands a stranger the group's keys and cannot be taken back — on a post-quantum MLS group the applicant's ratchet-tree leaf and Welcome are minted as part of this vote. A request another member nominated is carried the same way, and if the nominee has not yet asked to join it resolves to an invitation for it to accept rather than to a seat. This is a real, irreversible network action.`,
		inputSchema: groupVoteInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof groupVoteInput>>(
			opts,
			async (client, i) => {
				const group = await client.groups.resolveRef(i.group);
				try {
					// The record, not its id — but `vote` deliberately does not fold it:
					// its group read happens AFTER the approval it posts, and a read
					// whose job is to see what the POST did cannot be served from
					// before it.
					const result = await client.groups.vote(group, i.requestId, i.vote);
					return renderVote(i.group, result);
				} catch (err) {
					// The electorate refusals are the only ones this tool answers
					// itself: a bare "Not authorized" would leave the model retrying a
					// call whose outcome cannot change. Everything else is
					// `formatError`'s.
					const refusal = renderVoteRefusal(i.group, err);
					if (refusal) return refusal;
					throw err;
				}
			},
		),
	});
}

/** `rine_group_leave` — leave a group this agent is a member of. */
export function createRineGroupLeaveTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_leave",
		description:
			"Leave a group your agent is a member of. A leave posts no Remove commit — MLS gives nobody a way to commit their own removal — so the leaf stays in the ratchet tree until a member runs the reclamation pass, which any member may run and which costs the whole group one commit per leaf. What the leave does take is this host's key material for the group: its messages stop opening here, including ones that arrived before the leave and were never read, and nothing is taken back from anyone still in the group. This is a real, irreversible network action.",
		inputSchema: groupLeaveInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof groupLeaveInput>>(
			opts,
			async (client, i) => {
				// The record, so the leave's own `GET /groups/{id}` is served from the
				// row the resolve already paid for.
				const group = await client.groups.resolveRef(i.group);
				const result = await client.groups.leave(group);
				// The SDK composes the one accurate sentence for this group type.
				// Composing another one here is how the surfaces produced a sentence
				// that was false for open groups.
				return result.message;
			},
		),
	});
}

/** `rine_group_sync` — catch this host's MLS state up with the group. */
export function createRineGroupSyncTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_sync",
		description:
			"Catch this host's local key state for one group up with the group, when its messages stop opening. A post-quantum MLS group has two rungs: the cheap one replays the commits the server still holds and posts nothing itself; the expensive one posts a single external commit that re-seats this agent's leaf at the current epoch, which is O(members) and billed to every member. An open group runs sender keys and has no epoch chain, so there this installs the sender keys this host is missing — the ones waiting in its own inbox — and posts nothing. The report names which ran. Either rung ends by moving this agent's own leaf to its current key, which can post one path-only commit, and the report says where that leaf now stands. A group created to run MLS whose ratchet tree was never founded runs sender keys too, so it gets that same install, and the report additionally warns that the group has not got the MLS it was created for — a member has to found the group's MLS state, and no verb here does that.",
		inputSchema: groupSyncInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof groupSyncInput>>(
			opts,
			async (client, i) => {
				// The record, so the sync's own group read folds into the resolve.
				const group = await client.groups.resolveRef(i.group);
				const result = await client.groups.sync(group);
				return describeMlsRecovery(i.group, result);
			},
		),
	});
}

/** `rine_group_reclaim` — seat the unseated, then retire the orphaned leaves. */
export function createRineGroupReclaimTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_reclaim",
		description:
			"Seat every agent this post-quantum MLS group has invited and not yet given a ratchet-tree leaf, then retire the leaves that belong to no member and no live invitation. An invitation that lapses frees its seat and leaves its leaf behind, so a group that churns no-shows inflates every later Welcome and commit without bound, and nothing retires a leaf on its own — the server holds no MLS keys. Any member may run this; the deterrent is the cost, one Remove commit per leaf, each O(members) and billed to every member. An open group runs sender keys and has no ratchet tree, so it is refused. This is a real, irreversible network action.",
		inputSchema: groupReclaimInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof groupReclaimInput>>(
			opts,
			async (client, i) => {
				// The record, so the resume's own group read folds into the resolve.
				const group = await client.groups.resolveRef(i.group);
				// Through the resume verb rather than the reclamation alone:
				// reclamation declines outright while any member is missing a leaf, so
				// seating first is what keeps this from declining permanently on a
				// group nobody has resumed. It is the same code path the CLI's
				// resume-admission --reclaim runs, so no surface can drift from
				// another.
				const result = await client.groups.resumeMlsAdmission(group, {
					reclaim: true,
				});
				return renderReclamation(i.group, result);
			},
		),
	});
}
