/**
 * The local record of inbound messages that could not wake a workflow run, and
 * the in-process implementation of it. The durable one is `setaside-sqlite.ts`;
 * the bounded retry that later resumes them is `setaside-sweep.ts`.
 *
 * The gap this closes: the default driver is a long-lived SSE loop, and the rine
 * server marks a streamed frame delivered as it yields it — before any line of
 * this package runs. So a message the resumer skipped was already consumed: it
 * had left `status=new`, left `poll()` and left the SSE catch-up, and nothing
 * recorded its id. A group post that arrived before its sender key, or one whose
 * run had not been mapped yet, was gone. This is the record that makes such a
 * message answerable, and {@link SetAsideStore.due} is what answers it.
 *
 * 🔴 **Nothing in this module acknowledges a message.** Not a record, not the
 * attempt bound, not an overflow drop. Whatever the server did with the row on
 * the way in, this store never tells it to do more, and `rine_inbox` /
 * `rine_read` reach the message for as long as the server holds it.
 *
 * Ids and counters only — never ciphertext, never plaintext, never a decrypt
 * error's prose.
 */

import { SETASIDE_SWEEP_BATCH } from "./constants.js";
import {
	byFirstSeen,
	nextAttempt,
	nextRecord,
	overflowVictims,
} from "./setaside-merge.js";
import type { SetAsideEntry, SetAsideSighting } from "./setaside-words.js";

export * from "./setaside-merge.js";
export * from "./setaside-words.js";

/**
 * Where skipped inbound messages are parked.
 *
 * Every method is async so the durable libsql implementation fits the same
 * interface as the in-memory one, exactly as `ThreadMapStore` is shaped.
 *
 * Four methods, which is what the retry actually spends: the resumer records,
 * the sweep reads what is due, counts the retry it just ran, and forgets what
 * resumed. There is deliberately no listing verb — the store is not a
 * model-facing surface, and the durable answer to "where did my message go" is
 * the warning the sweep logs at the moment it gives up on one.
 */
export interface SetAsideStore {
	/**
	 * Park one skipped message, or refresh the entry it already has.
	 *
	 * Idempotent, and NOT an attempt: see `nextRecord`. Returns the entry as it
	 * now stands, so a caller can keep its log line to a first sighting or to one
	 * still being retried.
	 */
	record(sighting: SetAsideSighting): Promise<SetAsideEntry>;
	/**
	 * Count one spent retry against an entry and put it back.
	 *
	 * Takes the caller's copy rather than an id: the sweep is the only caller and
	 * it is holding one, and the merge needs it as the floor under the attempt
	 * count.
	 */
	countAttempt(entry: SetAsideEntry): Promise<SetAsideEntry>;
	/** The oldest entries still being retried, at most `limit` of them. */
	due(limit?: number): Promise<SetAsideEntry[]>;
	/** Forget one entry. The message itself is untouched. */
	forget(id: string): Promise<void>;
}

/**
 * In-process set-aside store. Per-process only — it does NOT survive a restart,
 * so a message parked here is answerable for as long as the host process lives
 * and no longer. That covers the cause this store exists for most often (a
 * sender key that arrives minutes later, a run that gets mapped on the next
 * turn) and nothing beyond it.
 *
 * It is the default so the fix is on without wiring, on the same terms
 * `InMemoryThreadMap` is offered beside `SqliteThreadMap`: use
 * `SqliteSetAside` for anything that must outlive the process.
 */
export class InMemorySetAside implements SetAsideStore {
	private readonly map = new Map<string, SetAsideEntry>();

	async record(sighting: SetAsideSighting): Promise<SetAsideEntry> {
		const entry = nextRecord(this.map.get(sighting.id), sighting, Date.now());
		this.map.set(entry.id, entry);
		for (const id of overflowVictims([...this.map.values()])) this.map.delete(id);
		return entry;
	}

	async countAttempt(entry: SetAsideEntry): Promise<SetAsideEntry> {
		const next = nextAttempt(this.map.get(entry.id), entry, Date.now());
		this.map.set(next.id, next);
		return next;
	}

	async due(limit: number = SETASIDE_SWEEP_BATCH): Promise<SetAsideEntry[]> {
		return [...this.map.values()]
			.filter((e) => !e.exhausted)
			.sort(byFirstSeen)
			.slice(0, limit);
	}

	async forget(id: string): Promise<void> {
		this.map.delete(id);
	}
}
