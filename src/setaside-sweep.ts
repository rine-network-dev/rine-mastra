/**
 * The bounded retry over the set-aside store. The store it reads and writes is
 * `setaside.ts`; WHEN it runs is `setaside-schedule.ts`.
 *
 * 🔴 **The re-read by id is the whole fix.** The default driver is an SSE loop
 * and the server marks a streamed frame delivered as it yields it, so a message
 * the resumer skipped has already left `status=new`, `poll()` and the SSE
 * catch-up. It is not coming back on its own, and no read option changes that
 * after the fact — a `GET` for its id is the only way to see those bytes again,
 * and the recorded id is the only reason this package still knows to ask.
 *
 * 🔴 The re-read nonetheless PEEKS. The webhook driver is the case it is for:
 * there the row may well still be `new`, and a retry that consumed it would
 * destroy the very message the store exists to protect — the second failure
 * would have nothing left to try. Peek costs nothing on a row that is already
 * delivered, so it is unconditional rather than per-driver.
 *
 * 🔴 A retry is a sync and THEN a read, for the entries a sync could heal
 * (`groupSyncMayHeal`). Retrying a bare local decrypt five times can only heal
 * by luck: what opens a sealed group message is the sender-key install or the
 * commit replay that `setaside-sync.ts` asks for.
 */

import { UUID_RE } from "@rine-network/core";
import { type MessageUuid, asMessageUuid } from "@rine-network/sdk";
import { SETASIDE_SWEEP_BATCH } from "./constants.js";
import type { RineThreadResumer } from "./inbound.js";
import { groupSyncMayHeal, isGone } from "./setaside-words.js";
import type { SetAsideEntry } from "./setaside-words.js";
import { syncGroupForRetry } from "./setaside-sync.js";
import type {
	GroupSyncClient,
	GroupSyncContext,
	SyncedGroups,
} from "./setaside-sync.js";
import type { DecryptedMessage } from "./types.js";

/**
 * The two SDK calls one retry spends.
 *
 * Narrowed to them, and extending the sync's client rather than restating it, so
 * a test can stand one up without an `AsyncRineClient` — and so this module
 * cannot quietly grow a third call on the retry path. A real client satisfies it
 * structurally.
 */
export interface RetryClient extends GroupSyncClient {
	/** `GET /messages/{id}`, decrypting with this host's keys. */
	read(id: MessageUuid, opts?: { peek?: boolean }): Promise<DecryptedMessage>;
}

/**
 * Everything the retry sweep needs.
 *
 * The resumer, not a store beside it: it OWNS the store it records into
 * ({@link RineThreadResumer.setAside}), so the sweep cannot be pointed at a
 * different one than the live path fills — which would read as a retry that
 * never fires, with both halves individually correct.
 */
export interface SweepArgs extends GroupSyncContext {
	client: RetryClient;
	resumer: RineThreadResumer;
}

/**
 * Re-read and re-attempt the entries still being retried, oldest first, at most
 * {@link SETASIDE_SWEEP_BATCH} of them.
 *
 * 🔴 The bound is per sweep, not per entry: `due` orders by `firstSeen`, so a
 * store longer than one batch is served from its head and the tail keeps its
 * place and its attempt count. Nothing is dropped; what the tail waits for is
 * the head clearing, which {@link SETASIDE_SWEEP_BATCH} spells out.
 *
 * A failing STORE stops the sweep rather than half-serving it — the entries keep
 * their places and their counts, and `setaside-schedule.ts` is where such a
 * failure is caught so it can never reach the live message that triggered it.
 */
export async function sweepSetAside(a: SweepArgs): Promise<void> {
	const due = await a.resumer.setAside.due(SETASIDE_SWEEP_BATCH);
	if (due.length === 0) return;
	a.logger.debug?.(`[rine] retrying ${due.length} set-aside message(s)`);
	// Per SWEEP: one absent sender key seals every message sent under it, so many
	// of this batch's entries share a group, and a sync per entry would ask one
	// question fifty times. Minted per sweep — five minutes on, the answer moved.
	const synced: SyncedGroups = new Set();
	for (const entry of due) await retryOne(a, entry, synced);
}

async function retryOne(
	a: SweepArgs,
	entry: SetAsideEntry,
	synced: SyncedGroups,
): Promise<void> {
	// A message id is a server-minted UUID, so a row whose id is not one can never
	// be read: retrying it would spend five round trips discovering that, and the
	// line at the end of them would hand the operator a `client.read("…")` that
	// cannot work either. Dropped once, and said out loud, because the only way to
	// hold such a row is a database shared with something else.
	if (!UUID_RE.test(entry.id)) {
		a.logger.warn?.(
			`[rine] set-aside row ${JSON.stringify(entry.id)} is not a rine message id; dropping it`,
		);
		await a.resumer.setAside.forget(entry.id);
		return;
	}
	// Sync BEFORE the read, not after a decrypt has failed again — and only for a
	// group message whose reason a sync can heal. `setaside-sync.ts` validates the
	// server-supplied id, bounds this to once per group per sweep, and never
	// throws, so the read runs either way and the attempt counted below is a read
	// that really happened — which is what `SETASIDE_MAX_ATTEMPTS` was sized to
	// bound.
	if (entry.groupId && groupSyncMayHeal(entry.reason)) {
		await syncGroupForRetry(a, entry.groupId, synced);
	}
	let msg: DecryptedMessage;
	try {
		msg = await a.client.read(asMessageUuid(entry.id), { peek: true });
	} catch (err) {
		// A row that is gone has nothing to retry; every other failure is this
		// attempt failing, which is what the bound counts.
		if (isGone(err)) await a.resumer.setAside.forget(entry.id);
		else await countAttempt(a, entry);
		return;
	}
	// Down the ordinary path, so a healed message gets exactly the resume a
	// first-sight one gets — and so a still-unresumable one is re-parked by the
	// resumer itself rather than by a second copy of that decision here.
	const outcome = await a.resumer.handleInbound(msg);
	if (!outcome.resumed) {
		await countAttempt(a, entry);
		return;
	}
	// 🔴 Forgotten AFTER the resume, not before it. The other order — openclaw's,
	// where a crash between the two would re-run an agent turn — is the right one
	// for a harness that cannot un-say a reply. Here the thing being re-run is a
	// workflow resume keyed on a `runId` that is no longer suspended, which the
	// `not-suspended` arm skips, and the package's own contract already tells a
	// workflow to key its idempotency on `messageId`. So the cheaper failure is
	// the duplicate attempt, and what this order buys is that a crash cannot
	// silently drop the record of a message that never actually resumed.
	await a.resumer.setAside.forget(entry.id);
	a.logger.debug?.(
		`[rine] set-aside message ${entry.id} resumed run ${outcome.runId} on retry ${entry.attempts + 1} (was ${entry.reason})`,
	);
}

/**
 * Count one spent retry against an entry, and say so once when it is the last.
 *
 * 🔴 The sentence names what is still true: nothing on this path acknowledged
 * the message, and the recorded id is what is left of it. It deliberately does
 * NOT promise the message is still in the inbox listing — on the SSE driver it
 * is not, because the server marked it delivered as it yielded the frame, and
 * that is exactly the false claim this whole store was built to stop repeating.
 */
async function countAttempt(a: SweepArgs, entry: SetAsideEntry): Promise<void> {
	const next = await a.resumer.setAside.countAttempt(entry);
	if (!next.exhausted) return;
	a.logger.warn?.(
		`[rine] set-aside message ${entry.id} still could not resume a run after ${next.attempts} attempts (${next.reason}) — no longer retried automatically. It was never acknowledged by this package, so it is still readable by id: client.read("${entry.id}").`,
	);
}
