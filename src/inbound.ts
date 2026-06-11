/**
 * Tier-3 inbound resumer (`RineThreadResumer`) — the TS analog of the Python
 * `RineThreadResumer`, much simpler because the SDK does SSE delivery.
 *
 * An inbound rine message wakes a SUSPENDED Mastra workflow run:
 *   1. resolve the message's `(handle, conversation_id)` → stored `runId` via the
 *      {@link ThreadMapStore} (no mapping ⇒ skip, do NOT ack — lossless);
 *   2. **rehydrate the snapshot via `getWorkflowRunById(runId)` BEFORE resume**
 *      (the load-bearing P0-10 recipe; defends mastra #5521 where
 *      `createRun({runId})` would otherwise read an empty in-process run-map);
 *      a non-suspended / unknown run ⇒ skip, do NOT ack;
 *   3. build `resumeData` from `plaintext` / `verified` / `from` ONLY
 *      (I-2: JSON-serializable, never ciphertext or an SDK client) — a
 *      decrypt-failed message ⇒ skip, do NOT ack;
 *   4. `createRun({runId}).resume({ step, resumeData })` to continue the run.
 *
 * **Lossless-by-default (langchain D16):** every skip path leaves the message in
 * the rine inbox (no `markDelivered`), so a later poll can retry after the run is
 * mapped / key recovery succeeds. The resumer NEVER acks.
 */

import { unwrapText } from "./format.js";
import type { ThreadMapStore } from "./threadmap.js";
import type { DecryptedMessage } from "./types.js";

/**
 * The minimal Mastra-workflow surface the resumer drives (the P0-10 recipe). A
 * real `mastra.getWorkflow(id)` satisfies this structurally — we type only the
 * two methods used so the package does not hard-couple to a workflow generic and
 * tests can pass a fake. `step` is the suspended step (a `createStep` object or
 * its string id), per `Run.resume({ step, resumeData })`.
 */
export interface ResumableWorkflow {
	/** Rehydrate a suspended run's snapshot from shared storage (or `null`). */
	getWorkflowRunById(runId: string): Promise<WorkflowSnapshot | null>;
	/** Reattach to a run by id; `resume` then continues from its suspended step. */
	createRun(opts: { runId: string }): Promise<ResumableRun>;
}

/** The rehydrated snapshot — only its suspended-status shape is read here. */
export interface WorkflowSnapshot {
	/** Run status; `"suspended"` means it is waiting on a resume. */
	status?: string;
	/** The suspended step path(s), when surfaced by the snapshot. */
	suspended?: unknown;
}

/** A run reattached by id, ready to `resume`. */
export interface ResumableRun {
	resume(params: { step?: unknown; resumeData: ResumeData }): Promise<unknown>;
}

/**
 * The JSON-serializable payload handed to the suspended step on resume. I-2:
 * plaintext + signature facts ONLY — no ciphertext, no envelope, no SDK client.
 */
export interface ResumeData {
	/** Unwrapped decrypted body (or a decrypt-error marker), never ciphertext. */
	plaintext: string;
	/** Whether the inbound message's signature verified. */
	verified: boolean;
	/** Sender handle (or agent UUID fallback), for the resumed step's context. */
	from: string;
	/** The inbound message id, for the step's threading/audit. */
	messageId: string;
}

/** Options for {@link RineThreadResumer}. */
export interface RineThreadResumerOptions {
	/** A pre-built workflow with snapshot storage already bound (P0-10). */
	workflow: ResumableWorkflow;
	/** The durable `(handle, conversation) → runId` map. */
	threadMap: ThreadMapStore;
	/** The suspended step to resume; omit when exactly one step is suspended. */
	step?: unknown;
	/** Optional logger; defaults to `console`. Used for skip-path diagnostics. */
	logger?: Pick<Console, "debug" | "warn">;
}

/** Outcome of {@link RineThreadResumer.handleInbound} — observable for drivers/tests. */
export type ResumeOutcome =
	| { resumed: true; runId: string }
	| {
			resumed: false;
			reason:
				| "no-map"
				| "not-suspended"
				| "decrypt-failed"
				| "no-conversation"
				| "failed";
	  };

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

	constructor(opts: RineThreadResumerOptions) {
		this.workflow = opts.workflow;
		this.threadMap = opts.threadMap;
		this.step = opts.step;
		this.log = opts.logger ?? console;
	}

	/**
	 * Resume the workflow run mapped to this message's thread. Returns the
	 * outcome; on any skip path it logs + returns `{ resumed: false }` and does
	 * NOT ack the message (lossless — it stays in the rine inbox for a retry).
	 */
	async handleInbound(msg: DecryptedMessage): Promise<ResumeOutcome> {
		const handle = senderHandle(msg);
		const conversation = msg.conversation_id;
		if (!handle || !conversation) {
			this.log.debug?.(
				"[rine] inbound has no (handle, conversation); skipping",
			);
			return { resumed: false, reason: "no-conversation" };
		}

		// I-2 + lossless: a message we can't decrypt cannot produce a safe
		// resumeData — leave it in the inbox for a retry after key recovery.
		if (msg.decrypt_error) {
			this.log.debug?.(
				`[rine] inbound ${msg.id} decrypt failed (${msg.decrypt_error}); skipping (no ack)`,
			);
			return { resumed: false, reason: "decrypt-failed" };
		}

		const runId = await this.threadMap.get(handle, conversation);
		if (!runId) {
			this.log.debug?.(
				`[rine] no run mapped for (${handle}, ${conversation}); skipping (no ack)`,
			);
			return { resumed: false, reason: "no-map" };
		}

		// Rehydrate from SHARED storage BEFORE resume (P0-10; defends #5521). A run
		// that is gone or no longer suspended must not be resumed — skip losslessly.
		const snapshot = await this.workflow.getWorkflowRunById(runId);
		if (!snapshot || snapshot.status !== "suspended") {
			this.log.debug?.(
				`[rine] run ${runId} not suspended (status=${snapshot?.status ?? "missing"}); skipping (no ack)`,
			);
			return { resumed: false, reason: "not-suspended" };
		}

		// I-2: resumeData is plaintext + signature facts ONLY — JSON-serializable,
		// never the ciphertext envelope or an SDK client.
		const resumeData: ResumeData = {
			plaintext: unwrapText(msg.plaintext),
			verified: msg.verified,
			from: handle,
			messageId: msg.id,
		};

		// Isolate a throwing resumed step / transient storage error (I-3, matching
		// the langchain precedent): a raise here must NOT propagate — it would
		// crash the poll-loop's per-message dispatch or reject into the webhook
		// caller's HTTP route. Skip losslessly (no ack), leaving the message in the
		// inbox for a later retry.
		try {
			const run = await this.workflow.createRun({ runId });
			await run.resume({ step: this.step, resumeData });
		} catch (err) {
			this.log.warn?.(
				`[rine] resume of run ${runId} failed; skipping (no ack):`,
				err,
			);
			return { resumed: false, reason: "failed" };
		}
		this.log.debug?.(
			`[rine] resumed run ${runId} for (${handle}, ${conversation})`,
		);
		return { resumed: true, runId };
	}
}
