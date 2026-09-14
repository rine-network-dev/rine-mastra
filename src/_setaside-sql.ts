/**
 * `SqliteSetAside`'s table: its DDL, its statements, and the mapping between one
 * row and one entry (split out of `setaside.ts` to keep each source file under
 * the ~200-LOC budget, exactly as `_threadmap-sql.ts` is split out of
 * `threadmap.ts`). One table holds the messages an inbound resume could not use,
 * so a restart does not forget them.
 *
 * 🔴 The table stores ids and counters only — never ciphertext, never plaintext,
 * never a decrypt error's prose. It can live in the same libsql database as the
 * thread map, which keeps the package's durable state one artefact to back up or
 * delete.
 *
 * The row mapping lives here and not with the store because it is the column
 * order's other half: `putArgs` and {@link COLUMNS} have to agree positionally,
 * and a silent argument-order slip is what they agree about.
 *
 * No `ORDER BY` in here expresses the EVICTION policy: overflow is decided by
 * `overflowVictims` in `setaside-merge.ts`, over rows this file hands back, so
 * the policy has one definition shared with the in-memory store.
 */

import type { Row, Value } from "@libsql/client";
import type { SetAsideEntry, SetAsideReason } from "./setaside-words.js";

/** The table name; namespaced so it never collides with Mastra's own tables. */
export const TABLE = "rine_mastra_setaside";

/** Column order every statement below reads and writes in. */
const COLUMNS =
	"message_id, reason, group_id, attempts, first_seen, last_tried, exhausted";

/** Create the set-aside table if it does not already exist. */
export const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  message_id TEXT NOT NULL PRIMARY KEY,
  reason TEXT NOT NULL,
  group_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_tried INTEGER,
  exhausted INTEGER NOT NULL DEFAULT 0
)`;

/**
 * Write one whole row.
 *
 * A full replace rather than an arithmetic upsert: the merge that decides
 * `attempts`, `firstSeen` and stickiness is `setaside-merge.ts`, shared with the
 * in-memory store, and the read it merges over is serialised against every other
 * merge by the store itself.
 */
export const PUT_SQL = `INSERT INTO ${TABLE} (${COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (message_id) DO UPDATE SET
    reason = excluded.reason,
    group_id = excluded.group_id,
    attempts = excluded.attempts,
    first_seen = excluded.first_seen,
    last_tried = excluded.last_tried,
    exhausted = excluded.exhausted`;

/** Read one row by message id. */
export const GET_SQL = `SELECT ${COLUMNS} FROM ${TABLE} WHERE message_id = ?`;

/** The oldest rows still being retried — what one sweep serves. */
export const DUE_SQL = `SELECT ${COLUMNS} FROM ${TABLE}
  WHERE exhausted = 0 ORDER BY first_seen ASC LIMIT ?`;

/** Every row, for the overflow decision. Read only when the count is over. */
export const ALL_SQL = `SELECT ${COLUMNS} FROM ${TABLE}`;

/** How many rows the table holds. */
export const COUNT_SQL = `SELECT COUNT(*) AS n FROM ${TABLE}`;

/** Drop one row (it resumed, or the server no longer has the message). */
export const FORGET_SQL = `DELETE FROM ${TABLE} WHERE message_id = ?`;

/** A libsql integer column as a number; `NULL` and a missing column read as 0. */
export function intColumn(value: Value | undefined): number {
	if (typeof value === "bigint") return Number(value);
	return typeof value === "number" ? value : 0;
}

/**
 * One row as an entry.
 *
 * 🔴 A `reason` this build does not know is kept as written, exactly as the
 * OpenClaw sidecar keeps one: it reaches a log line and two table lookups that
 * both answer `false` for an unknown key, so the entry stays retryable and stays
 * bounded by its attempt count. Dropping it would throw away a live retry, and
 * the retry is the whole point of the row.
 */
export function toEntry(row: Row): SetAsideEntry {
	return {
		id: typeof row.message_id === "string" ? row.message_id : "",
		reason: String(row.reason) as SetAsideReason,
		groupId: typeof row.group_id === "string" ? row.group_id : null,
		attempts: intColumn(row.attempts),
		firstSeen: intColumn(row.first_seen),
		lastTried: row.last_tried === null ? null : intColumn(row.last_tried),
		exhausted: intColumn(row.exhausted) !== 0,
	};
}

/** An entry as {@link PUT_SQL}'s arguments, in {@link COLUMNS} order. */
export function putArgs(entry: SetAsideEntry) {
	return [
		entry.id,
		entry.reason,
		entry.groupId,
		entry.attempts,
		entry.firstSeen,
		entry.lastTried,
		entry.exhausted ? 1 : 0,
	];
}
