/**
 * The admission strings this package composes itself: the outstanding list
 * `rine_group_requests` renders, the line `rine_group_vote` returns, the refusal
 * a vote from outside the electorate reads as, and what `rine_group_reclaim`
 * did to the ratchet tree.
 *
 * They sit beside `format.ts`'s group renderers rather than in the tool module,
 * in a sibling of their own for the same reason `schemas-groups.ts` is one —
 * `format.ts` holds its ~200-LOC budget. Their wording is fixed across every
 * surface that ships these verbs, so a vote reads the same here, from the CLI,
 * and from the Python connectors.
 *
 * Every other group verb returns a sentence composed once, further in: a removal
 * and a leave return `result.message` from the SDK, a sync returns
 * `describeMlsRecovery`, and the reclamation half below returns
 * `describeMlsReclamation`. The rest have no such sentence to return.
 */

import { describeMlsReclamation } from "@rine-network/core";
import {
	type MlsAdmissionResult,
	RineApiError,
	VoteEligibility,
	rineErrorCode,
} from "@rine-network/sdk";
import type { JoinRequestRead, VoteResponse } from "./types.js";

/**
 * What the reading agent's own standing on one request is, in a clause.
 *
 * A row that reported the arithmetic but not this would make an agent spend a
 * call to learn it cannot vote. The reason the server sends predicts the status
 * the vote route answers one-to-one, so the clause and the refusal agree by
 * construction rather than by two surfaces being kept in step.
 *
 * An unrecognised reason prints itself rather than being read as one of these:
 * this package can predate a reason the server has learned, and guessing "you
 * can vote" for one it has never seen is the surprise the whole model exists to
 * remove.
 */
function eligibilityClause(r: JoinRequestRead): string {
	switch (r.you_may_vote_reason) {
		case VoteEligibility.InElectorate:
			return "you can vote";
		case VoteEligibility.NotRecorded:
			return "you can vote (filed before the electorate was recorded; any member may)";
		case VoteEligibility.NotInElectorate:
			return "you cannot vote: you were not in the group when this was filed";
		case VoteEligibility.ElectorateEmpty:
			return "nobody eligible is still in the group";
		case VoteEligibility.BarUnreachable:
			return "nobody can decide this request";
		case VoteEligibility.IsApplicant:
			return "this is your own request";
		case VoteEligibility.AlreadyVoted:
			return `you already voted ${r.your_vote ?? "—"}`;
		case VoteEligibility.NotPending:
			return "not open for voting";
		default:
			// A reason this package has never seen prints itself. A MISSING one is
			// a row that never went through the SDK's parse, where the schema
			// default supplies the pre-electorate rule — say so rather than
			// printing `undefined` at a model, and never guess "you can vote".
			return r.you_may_vote_reason
				? `eligibility \`${r.you_may_vote_reason}\``
				: "eligibility not reported";
	}
}

/**
 * How far one request is from being decided: both bars, or nothing.
 *
 * The clause is dropped rather than zero-filled when the server reported no
 * counts at all — an invitation nobody votes on, and a row from a server that
 * predates the electorate — because `— approved, — more needed of — eligible`
 * reads as an arithmetic fact and is not one. A count it DID send is printed
 * even when the electorate size is missing, which is the shape every row filed
 * before the electorate shipped has: dropping those loses numbers the server
 * sent, and the Python twin prints them. When the electorate has emptied, the
 * eligibility clause already says so and the counts would only repeat it.
 *
 * The denial half follows that same rule one field down: dashed when the bar
 * alone is missing, dropped when the count is. It is reported at all because it
 * moves on its own — both bars fall as members leave — so a row showing only
 * the approval half cannot explain a request its standing denials went on to
 * refuse. A server that reports approvals and no denials therefore prints
 * exactly the clause it printed before the bar existed.
 */
function countsClause(r: JoinRequestRead): string {
	if (r.approvals === null || r.approvals === undefined) return "";
	if (r.electorate_size === 0) return "";
	const approvals = `${r.approvals} approved, ${r.approvals_needed ?? "—"} more needed of ${r.electorate_size ?? "—"} eligible`;
	if (r.denials === null || r.denials === undefined) return approvals;
	return `${approvals}; ${r.denials} denied, ${r.denials_needed ?? "—"} more would refuse it`;
}

/**
 * One outstanding row: request, applicant, status, where the vote stands, this
 * agent's own standing, and when the row lapses.
 *
 * `expires never` rather than a second phrasing for a null: the Python
 * connectors render exactly this, and a row shape that differs by stack is a
 * row a shared parser drops silently while the head line still counts it.
 */
function renderRequestRow(r: JoinRequestRead): string {
	const counts = countsClause(r);
	const counted = counts ? `${counts}  ` : "";
	return `${r.id}  ${r.agent_id}  ${r.status}  ${counted}${eligibilityClause(r)}  expires ${r.expires_at ?? "never"}`;
}

/**
 * The outstanding admissions of one group under one filter, oldest first.
 *
 * Sorted here rather than trusted from the wire: the ordering is what every
 * surface promises a voter, and the Python connectors sort too — so leaving it
 * to the server would make the same list read differently by stack.
 *
 * `groupRef` is the reference the caller gave, not a UUID it never named.
 */
export function renderRequests(
	groupRef: string,
	outstanding: string,
	rows: readonly JoinRequestRead[],
): string {
	if (rows.length === 0) {
		return `Nothing outstanding in \`${groupRef}\` under filter \`${outstanding}\`.`;
	}
	const oldestFirst = [...rows].sort((a, b) =>
		a.created_at.localeCompare(b.created_at),
	);
	const head = `Outstanding in \`${groupRef}\` (${outstanding}): ${rows.length}`;
	return [head, ...oldestFirst.map(renderRequestRow)].join("\n");
}

/**
 * The outcome of one vote.
 *
 * The leaf-and-Welcome sentence is conditioned on `mls_seated`, not on the
 * server's `approved`. The seat the SDK attempts inside `vote()` is
 * best-effort: a group running Sender Keys has no ratchet tree to mint a leaf
 * in, and an add commit that fails is logged and swallowed so the vote can
 * still be reported. On the status alone this claimed a Welcome for every vote
 * that minted none — which is exactly the failure the seat exists to prevent,
 * reported as a success.
 *
 * `invited` is the fourth answer a carried vote gives, and it is named rather
 * than left to the bare status line. A member may nominate an agent into a
 * `majority` or `unanimity` group, and the electorate can carry that nomination
 * before the nominee has asked for anything; the request then resolves to a
 * spendable invitation instead of a seat, so the agent that was never asked
 * still decides for itself. Reporting it as "approved" would claim a membership
 * that does not exist, and falling through to the bare line would leave a model
 * reading a status word no other outcome uses.
 */
export function renderVote(groupRef: string, result: VoteResponse): string {
	const line = `Vote \`${result.your_vote}\` recorded on request \`${result.request_id}\` in \`${groupRef}\`. Request status: \`${result.status}\`.`;
	if (result.status === "invited") {
		return `${line} The electorate approved it, and the applicant had not asked to join, so it holds a spendable invitation rather than a seat: it becomes a member when it accepts, and its ratchet-tree leaf and Welcome are minted then.`;
	}
	if (result.status !== "approved") return line;
	if (result.mls_seated) {
		return `${line} The applicant is now a member; their ratchet-tree leaf and Welcome were minted as part of this vote.`;
	}
	return `${line} The applicant is now a member. No ratchet-tree leaf or Welcome was minted by this vote, so on a group that runs MLS they read nothing until a member runs resume-admission on it.`;
}

/**
 * A vote the electorate rule refused, as something the model can act on —
 * or `undefined` for any other failure, which the shared `formatError` owns.
 *
 * Branching on the server's error CODE, never on its sentence: three 403s on
 * this route mean different things, and the detail is written for an operator
 * and is rewritten whenever the wording improves. `no vote was recorded` is
 * stated first because that is the fact an agent would otherwise have to infer
 * from a status code, and a retry of the same call cannot change any of them.
 *
 * There is deliberately no `BarUnreachable` arm. `bar_unreachable` and
 * `electorate_empty` are one refusal and two facts about the row: the route
 * raises `ElectorateEmptyError` for both, so an arm keyed on the other token
 * could never run, and the `ElectorateEmpty` sentence is true of both cases.
 * The two are told apart where they differ — on the row, by
 * {@link renderRequests}.
 */
export function renderVoteRefusal(
	groupRef: string,
	err: unknown,
): string | undefined {
	if (!(err instanceof RineApiError)) return undefined;
	switch (rineErrorCode(err)) {
		case VoteEligibility.NotInElectorate:
			return `No vote was recorded in \`${groupRef}\`: ${err.detail} Retrying will not help. rine_group_requests reports, on every row, how many of the eligible members are left and whether this agent is one of them.`;
		case VoteEligibility.ElectorateEmpty:
			return `No vote was recorded in \`${groupRef}\`: ${err.detail} No vote from anyone can decide this request, so it stands until it expires; rine_group_requests reports the date.`;
		case VoteEligibility.IsApplicant:
			return `No vote was recorded in \`${groupRef}\`: ${err.detail} Retrying will not help — this agent is the subject of that request, not one of the members who decide it. rine_group_requests reports how far it is from being decided.`;
		default:
			return undefined;
	}
}

/**
 * What one reclamation pass seated and what it retired.
 *
 * The pass seats first and reclaims second, so the report carries both: a leaf
 * belonging to an agent this run has just seated is not an orphan, and a
 * reclamation reported without the seating that preceded it would read as
 * though the tree had been trimmed against a roster nobody caught up.
 *
 * The reclamation half is `describeMlsReclamation` rather than a sentence of
 * this package's own — one implementation for the four TypeScript surfaces that
 * report a reclamation, sentence for sentence identical to the Python twin.
 */
export function renderReclamation(
	groupRef: string,
	result: MlsAdmissionResult,
): string {
	const seated = `Seated ${result.added} of ${result.outcomes.length} in ${result.commits} commit(s) in \`${groupRef}\`, now at epoch ${result.epoch}.`;
	const reclaimed = describeMlsReclamation(result.reclamation);
	return reclaimed ? `${seated} ${reclaimed}` : seated;
}
