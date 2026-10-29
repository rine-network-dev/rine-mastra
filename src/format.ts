/**
 * Pure render functions: turn SDK return values into the human-readable strings
 * tools hand back to the LLM. Ported field-for-field from the Python `_format.py`
 * — same snake_case wire field names —
 * with ONE inversion: the group MLS branch reads `[OK]` instead of `[WARN]`,
 * because the TS SDK fully reads/posts MLS + PQ traffic.
 *
 * These read ONLY `plaintext` / `decrypt_error` / verification
 * fields. They NEVER read `encrypted_payload` or any envelope/ciphertext field,
 * so ciphertext can never reach the LLM context through a rendered string.
 */

import { withA2aCleartextNotice } from "@rine-network/core";

// One definition per language: the SDK owns the group predicates, so a group
// renders the same way on every surface — and the four-state answer below is
// composed from them here rather than re-derived per call site.
import {
	groupIsMls,
	groupMlsInitInFlight,
	groupMlsNeverFounded,
	senderKeyExplainer,
	senderKeyExplanation,
	unfoundedGroupNote,
} from "@rine-network/sdk";
import type {
	AgentHandleMap,
	SenderKeyExplainer,
	ThreadEntry,
	WhoAmI,
} from "@rine-network/sdk";
import { NO_CONVERSATION, renderOwnAgents } from "./format-groups-list.js";
import type {
	AgentProfile,
	AgentSummary,
	DecryptedMessage,
	GroupRead,
	JoinRequestRead,
} from "./types.js";

/** One thread turn as a role-tagged line: `[sent] you: …` / `[received] alice@org: …`. */
function renderThreadLine(e: ThreadEntry): string {
	const who = e.direction === "sent" ? "you" : (e.senderHandle ?? "unknown");
	return `[${e.direction}] ${who}: ${e.text}`;
}

/**
 * Render a both-sided transcript (oldest→newest) for `rine_thread`. Each turn is a
 * role-tagged line; `[unavailable]` text passes through unchanged.
 */
export function renderThread(entries: readonly ThreadEntry[]): string {
	if (entries.length === 0) return "No messages in this conversation.";
	return entries.map(renderThreadLine).join("\n");
}

/** Honest signature note — never claims "verified" for an unverifiable message. */
export function verifiedNote(msg: DecryptedMessage): string {
	return msg.verified
		? "signature verified"
		: `signature ${msg.verification_status}`;
}

/**
 * THE PLAINTEXT-IS-JSON FOOTGUN. Outbound sends wrap `{ text: body }`, and the
 * SDK auto-`JSON.parse`s inbound `application/json` plaintext into a structured
 * value. Unwrap defensively so the model sees prose, never raw JSON:
 *   - a string → returned as-is
 *   - `{ text: "…" }` → the inner text
 *   - anything else → compact JSON (last resort)
 */
export function unwrapText(plaintext: unknown): string {
	if (typeof plaintext === "string") return plaintext;
	if (plaintext === null || plaintext === undefined) return "";
	if (typeof plaintext === "object") {
		const text = (plaintext as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	try {
		return JSON.stringify(plaintext);
	} catch {
		return String(plaintext);
	}
}

/**
 * Body of a message: decrypt error if unreadable, else the unwrapped plaintext —
 * led by the A2A cleartext notice when the body was never end-to-end encrypted.
 *
 * `explain` is the per-render tiering: pass it on a MULTI render (an inbox,
 * one call per `renderInbox()`) so the no-sender-key cause explains itself in
 * full on the first unreadable row and marks every subsequent one. Omit it on
 * a SINGLE render (`rine_read`, a `rine_send_and_wait` reply) so the one row
 * keeps the full sentence it already carries — there is nothing to tier when
 * the caller asked for exactly one message. Every other decrypt-error cause is
 * untouched either way; classification is the typed `decrypt_error_code`, never
 * the words in `decrypt_error`.
 */
export function renderMessageBody(
	msg: DecryptedMessage,
	explain?: SenderKeyExplainer,
): string {
	if (msg.decrypt_error) {
		const explanation = explain ? senderKeyExplanation(msg) : null;
		const text =
			explain && explanation ? explain(explanation).line : msg.decrypt_error;
		return `[unreadable] ${text}`;
	}
	return withA2aCleartextNotice(msg, unwrapText(msg.plaintext));
}

/** Sender label: prefer the human handle, fall back to the agent UUID. */
function senderLabel(msg: DecryptedMessage): string {
	return msg.sender_handle ?? msg.from_agent_id ?? "unknown sender";
}

/** A single message rendered across multiple labeled lines (for `rine_read`). */
export function renderSingleMessage(msg: DecryptedMessage): string {
	const lines = [
		`Message ${msg.id}`,
		`from: ${senderLabel(msg)}`,
		`type: ${msg.type}`,
	];
	if (msg.group_handle ?? msg.group_id) {
		lines.push(`group: ${msg.group_handle ?? msg.group_id}`);
	}
	lines.push(`body: ${renderMessageBody(msg)}`);
	lines.push(`(${verifiedNote(msg)})`);
	return lines.join("\n");
}

/** One inbox row: compact single line keyed by id + sender + body preview. */
function renderInboxRow(msg: DecryptedMessage, explain: SenderKeyExplainer): string {
	const from = senderLabel(msg);
	const where = msg.group_handle ? ` in ${msg.group_handle}` : "";
	return `${msg.id} from ${from}${where}: ${renderMessageBody(msg, explain)} (${verifiedNote(msg)})`;
}

/**
 * A numbered inbox list, or the empty-state line.
 *
 * MULTI render: one explainer per `renderInbox()` call, so the
 * no-sender-key cause explains itself once for this render and marks every
 * later row with the same cause — never module-level, never per-row.
 */
export function renderInbox(items: readonly DecryptedMessage[]): string {
	if (items.length === 0) return "No new messages.";
	const explain = senderKeyExplainer();
	return items
		.map((msg, i) => `${i + 1}. ${renderInboxRow(msg, explain)}`)
		.join("\n");
}

/** One discovery row. */
function renderAgentSummary(a: AgentSummary): string {
	const verified = a.verified ? " [verified]" : "";
	const desc = a.description ? ` — ${a.description}` : "";
	const cat = a.category ? ` (${a.category})` : "";
	return `${a.handle}${verified}${cat}${desc}`;
}

/** A numbered discovery list, or the empty-state line. */
export function renderDiscover(items: readonly AgentSummary[]): string {
	if (items.length === 0) return "No agents matched.";
	return items.map((a, i) => `${i + 1}. ${renderAgentSummary(a)}`).join("\n");
}

/** A full agent profile (for `rine_inspect`). */
export function renderProfile(p: AgentProfile): string {
	const lines = [
		`${p.name} (${p.handle})`,
		`id: ${p.id}`,
		`verified: ${p.verified ? "yes" : "no"}`,
		`human oversight: ${p.human_oversight ? "yes" : "no"}`,
	];
	if (p.category) lines.push(`category: ${p.category}`);
	if (p.description) lines.push(`description: ${p.description}`);
	return lines.join("\n");
}

/**
 * This agent's own identity, for `rine_whoami`: the org it belongs to, the
 * trust tier that org holds, and every handle it can act as.
 *
 * Revoked agents are dropped. The route returns them, and naming one here
 * would offer the model a handle nothing can be sent from or to.
 */
export function renderWhoAmI(me: WhoAmI): string {
	const slug = me.org.slug ? ` (${me.org.slug})` : "";
	const live = me.agents.filter((a) => !a.revoked_at).map((a) => a.handle);
	return [
		`Org ${me.org.name}${slug}`,
		`trust tier: ${me.trust_tier}`,
		`agents: ${live.length > 0 ? live.join(", ") : "none live"}`,
	].join("\n");
}

/**
 * A group rendered for `rine_group_inspect`. Every branch renders `[OK]`: an
 * MLS group is fully readable and postable here.
 *
 * Four states, not two. The second is the MLS init window: the group has no
 * `mls_group_id` to render yet, while the server already accepts nothing but
 * MLS there, so sends from here are MLS sends. Rendering that window as either
 * of the other states says the opposite of what is happening.
 *
 * The third is a group created to run MLS whose ratchet tree was never founded.
 * It reads to every other question exactly like the fourth — an ordinary
 * sender-key group — so it used to fall into it, and the agent was never told
 * the group had not got the encryption it was created for. It stays `[OK]`:
 * every claim that marker makes is true here, the group carries traffic, and
 * only the regime is other than intended. The sentence is the SDK's, and this
 * surface asks for the no-verb spelling because `rine_group_reclaim` refuses on
 * mastra — naming a verb that will not act is worse than naming none.
 *
 * `your agents` closes the gap the `[OK]` lines leave open: they describe how
 * the GROUP is run, not whether this org may act in it. A group can be perfectly
 * readable in the abstract and hold no seat of this org's at all. It names them
 * by handle when `handles` resolves them — the rule is stated once on
 * `AgentHandleMap` in the SDK, and `renderOwnAgents` is where it is applied.
 */
export function renderGroup(g: GroupRead, handles?: AgentHandleMap): string {
	const lines = [`Group ${g.handle} (id ${g.id})`];
	if (groupIsMls(g)) {
		lines.push(
			"[OK] MLS group — end-to-end encrypted (RFC 9420), readable/postable from here.",
		);
		if (g.mls_group_id) lines.push(`mls_group_id: ${g.mls_group_id}`);
	} else if (groupMlsInitInFlight(g)) {
		lines.push(
			"[OK] MLS group, initialising — end-to-end encrypted. Sends from here already use MLS.",
		);
	} else if (groupMlsNeverFounded(g)) {
		lines.push(
			`[OK] sender-key group — readable/postable from here. ${unfoundedGroupNote()}`,
		);
	} else {
		lines.push("[OK] sender-key group — readable/postable from here.");
	}
	lines.push(`enrollment: ${g.enrollment_policy}`);
	lines.push(`visibility: ${g.visibility}`);
	lines.push(`conversation_id: ${g.conversation_id ?? NO_CONVERSATION}`);
	lines.push(`your agents: ${renderOwnAgents(g.member_agent_ids, handles)}`);
	return lines.join("\n");
}

/** One pending-invite row for `rine_group_invites`. */
function renderInviteRow(r: JoinRequestRead): string {
	const group = r.group_handle ?? r.group_name ?? r.group_id;
	return `${group}: request ${r.id} (status ${r.status})`;
}

/** A numbered list of the caller's pending group invites, or the empty-state line. */
export function renderInvites(items: readonly JoinRequestRead[]): string {
	if (items.length === 0) return "No pending group invites.";
	return items.map((r, i) => `${i + 1}. ${renderInviteRow(r)}`).join("\n");
}
