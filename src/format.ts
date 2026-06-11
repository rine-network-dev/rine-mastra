/**
 * Pure render functions: turn SDK return values into the human-readable strings
 * tools hand back to the LLM. Ported field-for-field from the Python `_format.py`
 * (`AGENT_OUT_precedent_blueprint.md §6`) — same snake_case wire field names —
 * with ONE inversion: the group MLS branch reads `[OK]` instead of `[WARN]`,
 * because the TS SDK fully reads/posts MLS + PQ traffic (D-mls).
 *
 * Invariant I-2: these read ONLY `plaintext` / `decrypt_error` / verification
 * fields. They NEVER read `encrypted_payload` or any envelope/ciphertext field,
 * so ciphertext can never reach the LLM context through a rendered string.
 */

import type {
	AgentProfile,
	AgentSummary,
	DecryptedMessage,
	GroupRead,
} from "./types.js";

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

/** Body of a message: decrypt error if unreadable, else the unwrapped plaintext. */
export function renderMessageBody(msg: DecryptedMessage): string {
	if (msg.decrypt_error) return `[unreadable] ${msg.decrypt_error}`;
	return unwrapText(msg.plaintext);
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
function renderInboxRow(msg: DecryptedMessage): string {
	const from = senderLabel(msg);
	const where = msg.group_handle ? ` in ${msg.group_handle}` : "";
	return `${msg.id} from ${from}${where}: ${renderMessageBody(msg)} (${verifiedNote(msg)})`;
}

/** A numbered inbox list, or the empty-state line. */
export function renderInbox(items: readonly DecryptedMessage[]): string {
	if (items.length === 0) return "No new messages.";
	return items.map((msg, i) => `${i + 1}. ${renderInboxRow(msg)}`).join("\n");
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
 * Self-diagnose a group's E2EE mode. Uses `mls_group_id !== null` (the source of
 * truth — the public `EncryptionVersion` enum is MISSING `mls-v1`/`hpke-hybrid-v1`
 * despite the SDK decrypting them), OR the explicit `mls_enabled`/`mls_pending`
 * flags. With MLS support present this is now a CAPABILITY flag, not a failure flag.
 */
export function groupIsMls(g: GroupRead): boolean {
	return Boolean(g.mls_enabled || g.mls_group_id !== null || g.mls_pending);
}

/**
 * A group rendered for `rine_group_inspect`. THE INVERSION: both the MLS and
 * sender-key branches are `[OK]` — an MLS group is readable/postable here, not a
 * warned-about ceiling (the Python integration printed `[WARN] MLS — cannot
 * read/post`).
 */
export function renderGroup(g: GroupRead): string {
	const lines = [`Group ${g.handle} (id ${g.id})`];
	if (groupIsMls(g)) {
		lines.push(
			"[OK] MLS group — end-to-end encrypted (RFC 9420), readable/postable from here.",
		);
		if (g.mls_group_id) lines.push(`mls_group_id: ${g.mls_group_id}`);
	} else {
		lines.push("[OK] sender-key group — readable/postable from here.");
	}
	lines.push(`enrollment: ${g.enrollment_policy}`);
	lines.push(`visibility: ${g.visibility}`);
	return lines.join("\n");
}
