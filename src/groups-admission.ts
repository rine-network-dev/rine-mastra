/**
 * What an admission did, rendered for a model.
 *
 * A roster on `rine_group_create`, a batch on `rine_group_invite` and a single
 * `agentToInvite` are the same operation at three entry points, so they answer
 * in the same vocabulary. The two plural ones report one outcome per requested
 * agent, in the order they were named: a batch never fails whole — naming 32
 * agents and having one of them revoked costs that one agent its seat, not the
 * other 31 theirs — which is only useful if the caller is told which one.
 *
 * Two reports, deliberately not merged. The server's says whether an
 * **invitation** was minted; the MLS one says whether a ratchet-tree **leaf**
 * was. An agent can be `invited` in the first and `no_key_package` in the
 * second: it may join, and it will not be able to read a word until a leaf
 * exists for it. Collapsing them into one number is how that goes unreported.
 *
 * On a `majority` or `unanimity` group the server's answer is `nominated`
 * rather than `invited`: the invite files a join request the electorate
 * decides, and no leaf is minted for it. So a nomination has no MLS report at
 * all — the vote seats the member, and seating is what grants the key.
 *
 * The shapes and the reason→sentence maps are `@rine-network/core`'s, so this
 * module is the rendering and nothing else. A skip used to print the raw wire
 * token, which read as a refusal on exactly the groups it is not one for: an
 * open group mints no invitation because it needs none, and `not_applicable`
 * said nothing about that to a model deciding what to do next.
 */

import {
	type GroupAdmissionEntry,
	admissionHeadline,
	type GroupAdmissionReport,
	type MlsAdmissionResult,
	groupAdmissionSkipSentence,
	mlsAdmissionSkipSentence,
} from "@rine-network/core";

/** The refusal when a caller names both invite targets, or neither. */
export const INVITE_TARGET_REQUIRED =
	"Name exactly one of agentToInvite (one invitation) or agentsToInvite (a batch).";

/**
 * One line per requested agent.
 *
 * The word "skipped" is deliberately absent, matching the rule the Python
 * SDK's `describe_admission_entry` states in as many words: `status` is the
 * machine's vocabulary and what the reader needs is the fact. Leading with it
 * reinstated the softened contradiction on the two surfaces that did — an open
 * group's roster read "skipped — this group takes open enrollment…" to a model
 * here and just the fact to a crewai or langchain one, for the same response.
 *
 * `nominated` gets its own line, word for word the Python twin's, because a
 * nomination asks something different of its holder: an invitation is accepted,
 * a nomination waits on a vote that may refuse it. Printing it as "invited"
 * would tell a model an agent may walk in when the electorate has yet to decide.
 */
function admissionLine(entry: GroupAdmissionEntry): string {
	if (entry.status === "invited") return `  ${entry.agent_id}: invited`;
	if (entry.status === "nominated") {
		return `  ${entry.agent_id}: nominated, awaiting a vote`;
	}
	return `  ${entry.agent_id}: ${groupAdmissionSkipSentence(entry.reason)}`;
}

/**
 * What one `agentToInvite` produced, told from the row's own status.
 *
 * The singular route answers one row rather than a per-agent report, so the
 * status word is all a caller has to go on — and `Invited X (status pending)`
 * both claims something that did not happen and hands a model a word no other
 * outcome of this tool uses. `invited` and `pending` are therefore named, and
 * any other status still prints itself rather than being read as one of them.
 *
 * `invited` covers two shapes and the sentence names both. A closed group mints
 * a real invitation row that occupies a ratchet-tree seat until it is accepted
 * or expires; an open group answers `invited` having minted nothing at all,
 * because nobody needs an invitation to join one — and it runs sender keys, so
 * there is no ratchet tree for a seat to sit in.
 */
export function renderSingularInvite(
	agentRef: string,
	groupRef: string,
	status: string,
): string {
	if (status === "invited") {
		return `Invited ${agentRef} to ${groupRef}. A closed group mints an invitation that holds a ratchet-tree seat until it is accepted or expires; an open group mints none, because nobody needs one to join it.`;
	}
	if (status === "pending") {
		return `Nominated ${agentRef} into ${groupRef}. A nomination is a join request the group's electorate decides — this agent's own approval is counted toward it — and nobody is seated until the vote carries.`;
	}
	return `Invited ${agentRef} to ${groupRef} (status ${status}).`;
}

/** Per-agent invitation outcomes, one line each, in the order they were named. */
export function renderAdmission(report: GroupAdmissionReport): string {
	// The head is core's, derived from who was REACHED: `invited`/`skipped`
	// read "0 invited, N skipped" on every open group, over per-agent lines
	// saying those same agents may join whenever they like.
	return [admissionHeadline(report), ...report.entries.map(admissionLine)].join(
		"\n",
	);
}

/**
 * What the MLS admission seated, and who is still without a leaf.
 *
 * `already_in_group` is filtered out of the unseated list: an agent that
 * already holds a leaf is what a resumed admission looks like when it has
 * nothing left to do, not a failure to report.
 */
export function renderMlsAdmission(mls: MlsAdmissionResult): string {
	const head = `MLS: ${mls.added} seated across ${mls.commits} commit(s), group now at epoch ${mls.epoch}.`;
	const unseated = mls.outcomes.filter(
		(outcome) =>
			outcome.status === "skipped" && outcome.reason !== "already_in_group",
	);
	if (unseated.length === 0) return head;
	const named = unseated
		.map(
			(outcome) =>
				`\n  ${outcome.agentId}: ${mlsAdmissionSkipSentence(outcome.reason)}`,
		)
		.join("");
	return `${head}\nNo ratchet-tree leaf yet:${named}`;
}
