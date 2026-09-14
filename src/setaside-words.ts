/**
 * What a set-aside message is called, and the two questions asked of a parked
 * reason.
 *
 * Split out of `setaside.ts` for the file-size budget, on the same terms as
 * `_threadmap-sql.ts`: no I/O, no client, no crypto, nothing here can fail and
 * nothing here is stateful. The arithmetic these feed is `setaside-merge.ts`;
 * the store that PERSISTS them is `setaside.ts`, which re-exports both, so a
 * consumer imports one module.
 */

import { isAuthenticityFailure } from "@rine-network/core";
import type { DecryptedMessage } from "./types.js";

/**
 * Why a resume was skipped, as reported to the caller.
 *
 * Declared here rather than inline in `ResumeOutcome` because the set-aside
 * vocabulary is DERIVED from it ({@link SetAsideReason}) — restated, the two
 * drift, and the drift is a skip class that silently stops being retried.
 */
export type ResumeSkipReason =
	| "no-map"
	| "not-suspended"
	| "decrypt-failed"
	| "no-conversation"
	| "failed";

/**
 * Why a message is parked — the retry decision, not the error's prose.
 *
 * Every {@link ResumeSkipReason} plus `refused`, which is the split of
 * `decrypt-failed`: a signature that does not cover the bytes, or bytes
 * attributed to an agent that did not sign them. The resumer reports both as
 * `decrypt-failed` — widening its public outcome union would break a caller's
 * exhaustive switch — and only the store tells them apart, because only the
 * store has to decide whether to try again.
 */
export type SetAsideReason = ResumeSkipReason | "refused";

/** One sighting of an unresumable message: what {@link SetAsideEntry} is built from. */
export interface SetAsideSighting {
	/** rine message id — the only identifier, and the retry read's whole input. */
	readonly id: string;
	readonly reason: SetAsideReason;
	/** The group this was posted to, or `null` for a 1:1 message. */
	readonly groupId: string | null;
}

/**
 * One parked message.
 *
 * 🔴 Ids and counters only — never ciphertext, never plaintext, never the
 * decrypt error's prose. `groupId` is an id in that same sense and is kept for
 * one reason: it is what lets the retry catch the group up BEFORE it re-reads
 * and re-decrypts the row, rather than after a decrypt has already failed. The
 * connectors re-derive it from a decrypt-free fetch of the row; this package
 * reads through the SDK, whose read decrypts in the same call, so the sync
 * cannot run in between unless the id is already to hand.
 */
export interface SetAsideEntry extends SetAsideSighting {
	readonly attempts: number;
	/** epoch ms; the eviction order and the only age this store keeps. */
	readonly firstSeen: number;
	readonly lastTried: number | null;
	/** Retried no further. Still recorded, and its row is still on the server. */
	readonly exhausted: boolean;
}

/**
 * Read one skipped message as a sighting, splitting `decrypt-failed` in two.
 *
 * 🔴 The split is asked of `rine-core`'s {@link isAuthenticityFailure}, never of
 * an equality check against one status: `invalid` and `sender-mismatch` are both
 * authenticity verdicts, and a comparison written out here would silently accept
 * whichever one it forgot. `unverifiable` is deliberately NOT one of them — it is
 * a verdict that was never reached, which is exactly the transient class a retry
 * exists for.
 */
export function sightingOf(
	msg: DecryptedMessage,
	reason: ResumeSkipReason,
): SetAsideSighting {
	const refused =
		reason === "decrypt-failed" && isAuthenticityFailure(msg.verification_status);
	return {
		id: msg.id,
		reason: refused ? "refused" : reason,
		groupId: msg.group_id ?? null,
	};
}

/**
 * Is this reason one a retry can never answer?
 *
 * A table rather than a switch, and typed `Record<SetAsideReason, …>` on
 * purpose: every reason has to carry an answer here, so a new one is a missing
 * property and a compile error instead of silently landing in "retry it".
 *
 *  - `refused` — a forged signature or a misattributed sender is a property of
 *    the bytes. They cannot start to verify, so a retry can only ever reach the
 *    same verdict, and re-presenting attacker-controlled bytes on a timer is a
 *    log amplifier whose cadence the attacker picks. Recorded, never retried.
 *  - `no-conversation` — the row named no sender this package could key a thread
 *    by. That is a property of the row too: the same fetch returns the same
 *    fields forever.
 *
 * The other three heal, which is why they are parked rather than dropped: a run
 * gets mapped, a workflow suspends, a sender key arrives, a storage fault clears.
 */
const PERMANENT: Record<SetAsideReason, boolean> = {
	refused: true,
	"no-conversation": true,
	"no-map": false,
	"not-suspended": false,
	"decrypt-failed": false,
	failed: false,
};

/** Whether a retry could ever answer this reason. */
export function isPermanentSetAside(reason: SetAsideReason): boolean {
	return PERMANENT[reason] === true;
}

/**
 * Whether catching this message's GROUP up could open it, per reason.
 *
 * The same table discipline, and only one `true`: a group message this host
 * cannot decrypt is the one skip a sync addresses — it installs the sender keys
 * waiting in this agent's own inbox, or replays the commits this host has not
 * seen. `refused` is a verdict, not a missing key. The other three never reached
 * the ciphertext at all, so there is nothing about the group to catch up.
 *
 * Asked of the PERSISTED reason, which is what lets the sync run ahead of the
 * retry's read. A reason a newer build wrote and this one does not know answers
 * `false`: the lookup misses, and `=== true` refuses an `undefined`.
 */
const GROUP_SYNC_MAY_HEAL: Record<SetAsideReason, boolean> = {
	"decrypt-failed": true,
	refused: false,
	"no-conversation": false,
	"no-map": false,
	"not-suspended": false,
	failed: false,
};

/** Could a group sync open this parked message? */
export function groupSyncMayHeal(reason: SetAsideReason): boolean {
	return GROUP_SYNC_MAY_HEAL[reason] === true;
}

/**
 * Is this failure the row (or the group) being gone?
 *
 * Read off the `status` FIELD rather than with `instanceof NotFoundError`, for
 * the reason core's own refusal helpers give: two copies of a package in one
 * dependency tree make `instanceof` answer false, and `npm install
 * --install-links` COPIES `file:` deps, which is how this package's rigs get
 * exactly that. A misread 404 only costs an entry its retries, but it costs them
 * silently.
 *
 * 404 alone, deliberately. A 403 is an authorization answer that can change back
 * — reading it as "gone" would forget a parked message over a transient refusal,
 * and forgetting it is the one thing this store exists to prevent.
 */
export function isGone(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	return (err as { status?: unknown }).status === 404;
}
