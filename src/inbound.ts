/**
 * Tier-3 inbound resumer (`RineThreadResumer`) — the TS analog of the Python
 * `RineThreadResumer`, much simpler because the SDK does SSE delivery.
 *
 * An inbound rine message wakes a SUSPENDED Mastra workflow run:
 *   1. resolve the message's `(handle, conversation_id)` → stored `runId` via the
 *      {@link ThreadMapStore} (no mapping ⇒ set aside);
 *   2. **rehydrate the snapshot via `getWorkflowRunById(runId)` BEFORE resume**
 *      (the load-bearing recipe; defends mastra #5521 where
 *      `createRun({runId})` would otherwise read an empty in-process run-map);
 *      a non-suspended / unknown run ⇒ set aside;
 *   3. build `resumeData` from `plaintext` / `verified` / `from` ONLY
 *      (JSON-serializable, never ciphertext or an SDK client) — a
 *      decrypt-failed message ⇒ set aside;
 *   4. `createRun({runId}).resume({ step, resumeData })` to continue the run.
 *
 * 🔴 **Every skip records the message's id** in the {@link SetAsideStore}, and
 * `setaside-sweep.ts` re-reads those ids and re-attempts them under a bound.
 * That record is what makes a skip recoverable, because nothing else does: the
 * default driver is the SSE loop named above, and the rine server marks a
 * streamed frame delivered as it yields it — before any line of this file runs.
 * A skipped message has therefore already left `status=new`, `poll()` and the
 * SSE catch-up by the time it is skipped, so a `GET` for its id is the only way
 * to see those bytes again. Nothing here acknowledges a message on any path,
 * which on the webhook driver — where a row can still be `new` — is what also
 * keeps a skipped message in the inbox listing.
 *
 * TRUST NOTE: `verified === true` on an inbound message means the envelope
 * signature checked out AND the signing key it names belongs to the agent the
 * server authenticated as the sender, so the `from` handed to the resumed step is
 * the signer of that content. The signature covers the payload only — not this
 * recipient, and no nonce — so an agent re-sending content it signed earlier
 * produces a copy that verifies as its own. A workflow that must act on a payload
 * once keys its own idempotency on `messageId`.
 */

import { withA2aCleartextNotice } from "@rine-network/core";
import { unwrapText } from "./format.js";
import { InMemorySetAside, sightingOf } from "./setaside.js";
import type { ResumeSkipReason, SetAsideStore } from "./setaside.js";
import type { ThreadMapStore } from "./threadmap.js";
import type { DecryptedMessage } from "./types.js";
import type { ResumableWorkflow, ResumeData } from "./workflow.js";

export type {
	ResumableRun,
	ResumableWorkflow,
	ResumeData,
	WorkflowSnapshot,
} from "./workflow.js";

/** Options for {@link RineThreadResumer}. */
export interface RineThreadResumerOptions {
	/** A pre-built workflow with snapshot storage already bound. */
	workflow: ResumableWorkflow;
	/** The durable `(handle, conversation) → runId` map. */
	threadMap: ThreadMapStore;
	/** The suspended step to resume; omit when exactly one step is suspended. */
	step?: unknown;
	/**
	 * Where a skipped message's id is recorded for the bounded retry. Defaults
	 * to an {@link InMemorySetAside}, which forgets everything on restart; pass a
	 * `SqliteSetAside` for a host whose parked messages must outlive it.
	 */
	setAside?: SetAsideStore;
	/** Optional logger; defaults to `console`. Used for skip-path diagnostics. */
	logger?: Pick<Console, "debug" | "warn">;
}

/** Outcome of {@link RineThreadResumer.handleInbound} — observable for drivers/tests. */
export type ResumeOutcome =
	| { resumed: true; runId: string }
	| { resumed: false; reason: ResumeSkipReason };

/**
 * The sender label used as the thread `handle` key and as `resumeData.from`.
 * Prefers the human handle, falls back to the agent UUID (matches `format.ts`).
 */
function senderHandle(msg: DecryptedMessage): string | undefined {
	return msg.sender_handle ?? msg.from_agent_id ?? undefined;
}

/**
 * Wakes suspended Mastra workflow runs from inbound rine messages. Build ONE per
 * driver and feed every inbound message through {@link handleInbound}.
 */
export class RineThreadResumer {
	private readonly workflow: ResumableWorkflow;
	private readonly threadMap: ThreadMapStore;
	private readonly step?: unknown;
	private readonly log: Pick<Console, "debug" | "warn">;
	/**
	 * Where this resumer parks what it could not resume. Public and readonly so
	 * `setaside-sweep.ts` retries the SAME store this fills: a sweep handed a
	 * store of its own would read empty forever while the live path recorded into
	 * another — a retry that never fires, with both halves individually correct
	 * and no error anywhere.
	 */
	readonly setAside: SetAsideStore;

	constructor(opts: RineThreadResumerOptions) {
		this.workflow = opts.workflow;
		this.threadMap = opts.threadMap;
		this.step = opts.step;
		this.setAside = opts.setAside ?? new InMemorySetAside();
		this.log = opts.logger ?? console;
	}

	/**
	 * Resume the workflow run mapped to this message's thread.
	 *
	 * Returns the outcome; every skip path logs, records the message's id for the
	 * bounded retry, and acknowledges nothing.
	 */
	async handleInbound(msg: DecryptedMessage): Promise<ResumeOutcome> {
		const handle = senderHandle(msg);
		const conversation = msg.conversation_id;
		if (!handle || !conversation) {
			this.log.debug?.(
				"[rine] inbound has no (handle, conversation); setting aside",
			);
			return this.setAsideSkip(msg, "no-conversation");
		}

		// A message we can't decrypt cannot produce a safe resumeData. Its id is
		// recorded, and the retry catches the group up before re-reading it — which
		// is what actually heals a group message that arrived before its key.
		if (msg.decrypt_error) {
			this.log.debug?.(
				`[rine] inbound ${msg.id} decrypt failed (${msg.decrypt_error}); setting aside`,
			);
			return this.setAsideSkip(msg, "decrypt-failed");
		}

		const runId = await this.threadMap.get(handle, conversation);
		if (!runId) {
			this.log.debug?.(
				`[rine] no run mapped for (${handle}, ${conversation}); setting aside ${msg.id}`,
			);
			return this.setAsideSkip(msg, "no-map");
		}

		// Rehydrate from SHARED storage BEFORE resume (defends #5521). A run that
		// is gone or no longer suspended must not be resumed — set aside instead,
		// because the run this thread maps to may suspend again.
		const snapshot = await this.workflow.getWorkflowRunById(runId);
		if (!snapshot || snapshot.status !== "suspended") {
			this.log.debug?.(
				`[rine] run ${runId} not suspended (status=${snapshot?.status ?? "missing"}); setting aside ${msg.id}`,
			);
			return this.setAsideSkip(msg, "not-suspended");
		}

		// resumeData is plaintext + signature facts ONLY — JSON-serializable,
		// never the ciphertext envelope or an SDK client.
		const resumeData: ResumeData = {
			plaintext: withA2aCleartextNotice(msg, unwrapText(msg.plaintext)),
			verified: msg.verified,
			from: handle,
			messageId: msg.id,
		};

		// Isolate a throwing resumed step / transient storage error, the way the
		// langchain adapter does: a raise here must NOT propagate — it would crash
		// the driver's per-message dispatch or reject into the webhook caller's
		// HTTP route. Set the message aside instead, so a transient storage fault
		// costs a retry rather than the message.
		try {
			const run = await this.workflow.createRun({ runId });
			await run.resume({ step: this.step, resumeData });
		} catch (err) {
			this.log.warn?.(
				`[rine] resume of run ${runId} failed; setting aside ${msg.id}:`,
				err,
			);
			return this.setAsideSkip(msg, "failed");
		}
		this.log.debug?.(
			`[rine] resumed run ${runId} for (${handle}, ${conversation})`,
		);
		return { resumed: true, runId };
	}

	/**
	 * Record one skipped message's id, then report the skip.
	 *
	 * Best-effort, and the one failure here that really does lose a message says
	 * so: the stream has already consumed the row, so an id never written down
	 * leaves nothing to retry and nothing to name. It must not propagate — a
	 * store fault would otherwise turn a skipped message into a crashed dispatch.
	 *
	 * 🔴 The reason goes through `sightingOf`, which splits `decrypt-failed` into
	 * a retryable failure and a permanent `refused`. The arm's own reason would
	 * put attacker-controlled bytes back on a timer the attacker paces.
	 */
	private async setAsideSkip(
		msg: DecryptedMessage,
		reason: ResumeSkipReason,
	): Promise<ResumeOutcome> {
		try {
			await this.setAside.record(sightingOf(msg, reason));
		} catch (err) {
			this.log.warn?.(
				`[rine] could not record set-aside message ${msg.id} (${reason}); it will not be retried:`,
				err,
			);
		}
		return { resumed: false, reason };
	}
}
