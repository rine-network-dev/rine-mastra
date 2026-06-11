/**
 * SQL constants for {@link SqliteThreadMap} (split out of `threadmap.ts` to keep
 * each source file under the ~200-LOC budget). One table maps a
 * `(handle, conversation_id)` thread to the suspended Mastra workflow `runId`.
 *
 * The composite key is the durable analog of a LangGraph `thread_id`: it is OUR
 * responsibility (separate from Mastra's own workflow-snapshot storage) so a
 * fresh process can find the right suspended run for an inbound rine message.
 */

/** The table name; namespaced so it never collides with Mastra's own tables. */
export const TABLE = "rine_mastra_threadmap";

/** Create the thread-map table if it does not already exist. */
export const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  handle TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (handle, conversation_id)
)`;

/** Upsert a `(handle, conversation_id) → runId` row. */
export const SET_SQL = `INSERT INTO ${TABLE} (handle, conversation_id, run_id, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (handle, conversation_id)
  DO UPDATE SET run_id = excluded.run_id, updated_at = excluded.updated_at`;

/** Look up the runId for a `(handle, conversation_id)` pair. */
export const GET_SQL = `SELECT run_id FROM ${TABLE}
  WHERE handle = ? AND conversation_id = ?`;

/** Delete the mapping for a `(handle, conversation_id)` pair. */
export const DELETE_SQL = `DELETE FROM ${TABLE}
  WHERE handle = ? AND conversation_id = ?`;
