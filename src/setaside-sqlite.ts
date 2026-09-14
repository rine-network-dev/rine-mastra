/**
 * The durable {@link SetAsideStore}: one libsql table of the inbound messages a
 * resume could not use. A file URL is what makes a parked message answerable
 * after a restart — the in-memory store forgets it, and the message it forgets
 * was already consumed off the stream.
 *
 * It can share the database `SqliteThreadMap` uses, which keeps this package's
 * durable state one artefact to back up or delete. Build it where the driver is
 * wired (a long-lived host start), never at module import: opening it opens a
 * libsql handle.
 */

import { type Client, createClient } from "@libsql/client";
import {
	ALL_SQL,
	COUNT_SQL,
	CREATE_TABLE_SQL,
	DUE_SQL,
	FORGET_SQL,
	GET_SQL,
	PUT_SQL,
	intColumn,
	putArgs,
	toEntry,
} from "./_setaside-sql.js";
import { SETASIDE_MAX_ENTRIES, SETASIDE_SWEEP_BATCH } from "./constants.js";
import {
	nextAttempt,
	nextRecord,
	overflowVictims,
} from "./setaside-merge.js";
import type { SetAsideEntry, SetAsideSighting } from "./setaside-words.js";
import type { SetAsideStore } from "./setaside.js";

/** Options for {@link SqliteSetAside.open}. */
export interface SqliteSetAsideOptions {
	/**
	 * libsql URL. `file:rine-setaside.db` (durable, the production default),
	 * `:memory:` (ephemeral, and then the in-memory store is the simpler choice),
	 * or a remote `libsql://…` for a hosted Turso DB.
	 */
	url: string;
	/** Optional auth token for a remote libsql/Turso URL. */
	authToken?: string;
}

/**
 * libsql-backed {@link SetAsideStore}.
 *
 * Every merge is a read-modify-write, and they run ONE AT A TIME: the sweep and
 * the live inbound path share this store, and an interleaved pair would both
 * read the same attempt count and both write the same successor — a lost
 * attempt, which is an unbounded retry loop rather than a cosmetic slip.
 *
 * 🔴 The queue below is deliberately NOT a libsql `transaction()`.
 * `Sqlite3Client.transaction()` hands its connection to the transaction and
 * nulls its own handle, and nothing ever closes the handed-over one: measured
 * here, 500 write transactions leaked 499 file descriptors with no reclamation,
 * so a sweep of 50 parked messages every five minutes reaches a 1024-fd limit
 * within the hour. Serialising in-process buys the same protection for the two
 * writers that actually exist.
 *
 * What that leaves open, stated plainly: two PROCESSES pointed at one file can
 * still lose an attempt count. The bound survives it — `nextAttempt` takes the
 * larger of the caller's view and the stored row, so the worst case is a message
 * retried a few more times, never forever — but a host that scales past one
 * process should point these at a shared Turso URL and not at a shared file.
 */
export class SqliteSetAside implements SetAsideStore {
	/** Tail of the merge queue; see the class docblock for why it exists. */
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(private readonly client: Client) {}

	/** Open the store and ensure its table exists. */
	static async open(opts: SqliteSetAsideOptions): Promise<SqliteSetAside> {
		const client = createClient({
			url: opts.url,
			...(opts.authToken ? { authToken: opts.authToken } : {}),
		});
		await client.execute(CREATE_TABLE_SQL);
		return new SqliteSetAside(client);
	}

	async record(sighting: SetAsideSighting): Promise<SetAsideEntry> {
		return this.merge(sighting.id, (found) => {
			const entry = nextRecord(found, sighting, Date.now());
			return { entry, evict: true };
		});
	}

	async countAttempt(entry: SetAsideEntry): Promise<SetAsideEntry> {
		return this.merge(entry.id, (found) => ({
			entry: nextAttempt(found, entry, Date.now()),
			evict: false,
		}));
	}

	async due(limit: number = SETASIDE_SWEEP_BATCH): Promise<SetAsideEntry[]> {
		const res = await this.client.execute({ sql: DUE_SQL, args: [limit] });
		return res.rows.map(toEntry);
	}

	async forget(id: string): Promise<void> {
		await this.client.execute({ sql: FORGET_SQL, args: [id] });
	}

	/** Close the underlying libsql handle. */
	close(): void {
		this.client.close();
	}

	/** Read one row, decide the next one, write it back — one merge at a time. */
	private merge(
		id: string,
		decide: (found: SetAsideEntry | undefined) => {
			entry: SetAsideEntry;
			evict: boolean;
		},
	): Promise<SetAsideEntry> {
		return this.serialize(async () => {
			const prior = await this.client.execute({ sql: GET_SQL, args: [id] });
			const row = prior.rows[0];
			const { entry, evict } = decide(row ? toEntry(row) : undefined);
			await this.client.execute({ sql: PUT_SQL, args: putArgs(entry) });
			if (evict) await this.evictOverflow();
			return entry;
		});
	}

	/**
	 * Run `work` after every merge queued before it.
	 *
	 * A rejection is not allowed to break the chain — one failed record must not
	 * strand every later one — and the tail is a settled promise nobody awaits, so
	 * it must never be a rejected one.
	 */
	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(work, work);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/**
	 * Bring the table back to {@link SETASIDE_MAX_ENTRIES}.
	 *
	 * The count is asked first so the whole-table read happens only when the store
	 * is actually full. The ORDER is not an `ORDER BY`: `overflowVictims` decides
	 * it, so the eviction policy has one definition both stores obey.
	 */
	private async evictOverflow(): Promise<void> {
		const counted = await this.client.execute(COUNT_SQL);
		if (intColumn(counted.rows[0]?.n) <= SETASIDE_MAX_ENTRIES) return;
		const all = await this.client.execute(ALL_SQL);
		for (const id of overflowVictims(all.rows.map(toEntry))) {
			await this.client.execute({ sql: FORGET_SQL, args: [id] });
		}
	}
}
