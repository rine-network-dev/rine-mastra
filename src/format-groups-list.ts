/**
 * The plural group renderers: the caller's own groups, a directory search, and
 * one group's roster. `format.ts`'s `renderGroup` renders exactly ONE group and
 * is what `rine_group_inspect` returns; these render pages, one numbered row
 * each, in the shape `renderInbox`/`renderDiscover` already use.
 *
 * A sibling of `format.ts` rather than part of it, for the same reason
 * `format-groups.ts` is one — `format.ts` holds its ~200-LOC budget.
 *
 * Ciphertext cannot leak into the model's context through these renderers: a
 * group, a directory entry and a roster row carry no message payload at all.
 *
 * The types come from `@rine-network/sdk` directly: the SDK exports them
 * alongside their schemas, so there is nothing here to re-derive.
 */

import {
	type AgentHandleMap,
	type GroupMember,
	type GroupRead,
	type GroupSummary,
	groupIsMls,
	groupMlsInitInFlight,
	groupMlsNeverFounded,
} from "@rine-network/sdk";

/**
 * What a group with no conversation renders instead of an id.
 *
 * A group's thread is created lazily on its first post, so a null
 * `conversation_id` is the fact "nothing has been said in this group yet" — not
 * an error, not a refusal, and not a missing field. The clause is never omitted
 * on null: a model that sees it on some rows and not others reads the absence
 * as a rendering fault rather than as a fact about the group.
 *
 * `format.ts`'s `renderGroup` imports it from here so the two renderers cannot
 * tell a model two different things about the same group. The same sentence is
 * printed by the CLI, crewai, langchain, hermes and eve; it is restated per
 * package because there is no runtime module all of them import.
 */
export const NO_CONVERSATION = "(none — nothing has been said in this group yet)";

/**
 * What a group renders in place of an agent list when this org holds no seat.
 *
 * The group list is ORG-scoped — it reports every group any agent of this org
 * is in — so a row on it was never proof that the agent this host is acting as
 * may post there. The empty list is that proof's absence stated plainly: no
 * agent of this org is seated, and a send into the group would be refused.
 *
 * Never omitted, for the reason `NO_CONVERSATION` gives above: a clause a model
 * sees on some rows and not others reads as a rendering fault rather than as a
 * fact about the group. Restated per package because there is no runtime module
 * all seven rendering surfaces import — though this package and its twin do
 * share one (`@rine-network/sdk`), so the day either reworded its row would be
 * the day the sentence belongs there instead.
 *
 * Pinned meanwhile: `tests/test_client-server-contract_group0.py` compares the
 * four declared copies against `rine.group_words.NO_OWN_AGENTS`, which the
 * three Python surfaces import, so a reword in one package fails there rather
 * than shipping two answers to one question.
 */
export const NO_OWN_AGENTS = "(none — no agent of your org is seated in this group)";

/**
 * The seated-agents clause, from the one place both renderers read it.
 *
 * `format.ts`'s `renderGroup` calls this too, so the row and the single-group
 * view cannot tell a model two different things about the same group — the same
 * reason `NO_CONVERSATION` is imported there rather than retyped.
 *
 * Each id renders as its HANDLE. The three cases, and why a name is never one
 * of them, are stated once on `AgentHandleMap` in the SDK
 * (`rine-ts-sdk/src/resources/agent-handles.ts`); this renderer is one of the
 * four that follow them. In short: a known id prints its handle, an unknown one
 * prints itself, an empty list prints {@link NO_OWN_AGENTS}. A model handed a
 * UUID cannot tell which of its agents it names — that is the whole reason
 * handle resolution exists here — but a UUID is still addressable, so an
 * unresolved id is degraded, not lost.
 *
 * `handles` is omitted whenever the org's agent list could not be read; that is
 * case 2 for every id, and it is why nothing here throws.
 *
 * `undefined` is accepted on purpose. `GroupReadSchema` defaults the field to
 * `[]`, so a parsed row always has one — but a row that never went through that
 * parse (a hand-built object, a fake) has nothing, and a renderer whose job is
 * to state an absence must not throw on one.
 */
export function renderOwnAgents(
	ids: readonly string[] | undefined,
	handles?: AgentHandleMap,
): string {
	if (!ids || ids.length === 0) return NO_OWN_AGENTS;
	return ids.map((id) => handles?.get(id.toLowerCase()) ?? id).join(", ");
}

/**
 * How this package names a group's regime in one field, for a LIST ROW.
 *
 * One definition for the row, and for the row only. It is NOT what the create
 * confirmation head asks: what a freshly created group runs is decided from the
 * create RESULT, by `createdGroupMls` in `@rine-network/core`, because the row
 * alone cannot tell a founded group from an unfounded one. `renderGroup`'s
 * `[OK]` line re-derives its first clause from the predicates directly and has
 * never called this either. So a reword here reaches this row and nothing else,
 * and a reword in either of those two does not reach this row.
 *
 * The init window is reported as MLS because sends into it already are MLS, and
 * a field that said "sender-key" there would state the opposite of what is
 * happening. The window's own distinction is `rine_group_inspect`'s to make.
 *
 * A group created to run MLS whose ratchet tree was never founded really does
 * carry sender-key traffic, so it names sender keys — and says the rest of the
 * answer, because that row is otherwise field-for-field an open group's and
 * nothing else on the page can tell the two apart. The parenthesis carries NO
 * comma: the row below is comma-separated, which is the same reason its last
 * clause opens with `; `. The whole sentence lives in `rine_group_inspect`; a
 * list row is not the place for it.
 */
export function groupModeLabel(g: GroupRead): string {
	if (groupIsMls(g) || groupMlsInitInFlight(g)) return "MLS";
	if (groupMlsNeverFounded(g)) return "sender-key (MLS never founded)";
	return "sender-key";
}

/**
 * One row of the caller's own groups.
 *
 * The row carries `conversation_id` because this is the only place a model can
 * learn it without having already sent into the group or been handed a raw
 * message row: list the groups, take the id off the row, hand it to
 * `rine_thread`. The key is spelled as the wire field rather than as prose so
 * that the string the model reads and the argument it must fill match.
 *
 * It also names which of this org's agents hold a seat here. `member_count` is
 * the whole roster across every org; this clause is the caller's own share of
 * it, and it is the only thing on an org-scoped row that says whether this org
 * can act in the group at all.
 *
 * That clause closes the row with `; ` rather than `, ` because its VALUE is a
 * comma-joined list. Ending a comma-separated row with a comma-containing field
 * makes the row's field count depend on how many seats the org holds, so a
 * reader that split on `, ` would mis-read multi-seat rows only — and read
 * single-seat ones correctly, which is how that would ship.
 */
function renderGroupRow(g: GroupRead, handles?: AgentHandleMap): string {
	const mode = groupModeLabel(g);
	const conversation = g.conversation_id ?? NO_CONVERSATION;
	const yours = renderOwnAgents(g.member_agent_ids, handles);
	return `${g.handle} (id ${g.id}) — ${mode}, enrollment ${g.enrollment_policy}, ${g.member_count} member(s), conversation_id=${conversation}; your agents: ${yours}`;
}

/**
 * A numbered list of the groups this org's agents are seated in, or the
 * empty-state line.
 *
 * The list is org-scoped, and each row's `your agents` clause names which of
 * this org's agents are seated in that group — an empty clause means none of
 * them is, and a send into that group would be refused. The clause names them
 * by handle because that is the spelling `rine_whoami` prints, so the two
 * outputs can be read against each other — a UUID matched nothing this surface
 * had ever shown the model. What neither tool says is which agent this host is
 * acting AS: `WhoAmI` carries no such field and `renderWhoAmI` marks no row, so
 * in a multi-agent org that still has to come from the host's own config (the
 * `agent` this client was built with, which may itself have been given as a
 * UUID).
 */
export function renderGroups(
	items: readonly GroupRead[],
	handles?: AgentHandleMap,
): string {
	if (items.length === 0) return "This agent belongs to no groups.";
	return items
		.map((g, i) => `${i + 1}. ${renderGroupRow(g, handles)}`)
		.join("\n");
}

/**
 * One directory row.
 *
 * No encryption mode: a directory result carries no MLS latch at all, so
 * naming one here would be an invention. `rine_group_inspect` answers that
 * question, and only for a group an agent of this org is already in.
 */
function renderGroupSummaryRow(g: GroupSummary): string {
	const desc = g.description ? ` — ${g.description}` : "";
	return `${g.handle} (id ${g.id}) — enrollment ${g.enrollment_policy}, ${g.member_count} member(s)${desc}`;
}

/**
 * A numbered list of publicly listed groups, or the empty-state line.
 *
 * The header says what the list IS. `GET /directory/groups` is an
 * unauthenticated public-visibility scan across every org and carries no
 * identity at all, so nothing on a row can say whether this agent holds a seat
 * in that group — while `renderGroups` above prints near-identical rows that
 * end with exactly that. Two numbered lists told apart by two words in a header
 * is not enough, so this one says the difference outright.
 *
 * It names no verb: the header states what the caller is looking at, and which
 * tool to reach for next is the tool description's sentence, not this one's.
 */
export function renderGroupSummaries(items: readonly GroupSummary[]): string {
	if (items.length === 0) return "No public groups matched.";
	const head = `${items.length} public group(s) found in the directory. A row here is a group that exists, not a group this agent is in:`;
	return [head, ...items.map((g, i) => `${i + 1}. ${renderGroupSummaryRow(g)}`)].join("\n");
}

/**
 * One roster row: who they are, what they may do, and since when.
 *
 * The join date renders date-only, and the same way on every surface that
 * renders a roster: `joined_at` is a validated ISO-8601 timestamp on the wire
 * (`GroupMemberSchema`), and a model reading seven surfaces should not have to
 * parse three renderings of the same field.
 *
 * A row of this org's own is suffixed `(yours)`. That is a MARKER, not a
 * filter: every member of the group is listed whichever org holds the seat, and
 * the suffix only says which of them this host could act as.
 */
function renderMemberRow(m: GroupMember): string {
	const joined = m.joined_at.slice(0, 10);
	const own = m.is_own_org ? " (yours)" : "";
	return `${m.agent_handle ?? m.agent_id} — ${m.role}, joined ${joined}${own}`;
}

/**
 * A numbered roster, or the empty-state line.
 *
 * The roster is members only. An invitation and a nomination hold a seat
 * against the group's ceiling without appearing here — `rine_group_requests`
 * is what reports those — so a roster shorter than the ceiling suggests is not
 * a gap in this list.
 *
 * Every member is listed, from every org. Nothing here filters on whose agent
 * a row is; `(yours)` marks this org's rows and takes none away.
 */
export function renderRoster(items: readonly GroupMember[]): string {
	if (items.length === 0) return "No members reported for this group.";
	return items.map((m, i) => `${i + 1}. ${renderMemberRow(m)}`).join("\n");
}
