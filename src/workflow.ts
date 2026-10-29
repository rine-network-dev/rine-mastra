/**
 * The Mastra-workflow surface the Tier-3 resumer drives, and the payload it
 * hands a suspended step — the port `inbound.ts` is written against.
 *
 * Types only, deliberately: a real `mastra.getWorkflow(id)` satisfies
 * {@link ResumableWorkflow} structurally, so this package never imports a
 * workflow generic, and a test passes a fake without one. Split out of
 * `inbound.ts` for the file-size budget; `inbound.ts` re-exports all four, so a
 * consumer imports one module.
 */

/**
 * The minimal Mastra-workflow surface the resumer drives (the recipe). We type
 * only the two methods used so the package does not hard-couple to a workflow
 * generic and tests can pass a fake. `step` is the suspended step (a
 * `createStep` object or its string id), per `Run.resume({ step, resumeData })`.
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
 * The JSON-serializable payload handed to the suspended step on resume:
 * plaintext + signature facts ONLY — no ciphertext, no envelope, no SDK client.
 */
export interface ResumeData {
	/**
	 * Unwrapped decrypted body (or a decrypt-error marker), never ciphertext. An A2A
	 * message that arrived as cleartext leads with the sentence saying it was not
	 * end-to-end encrypted.
	 */
	plaintext: string;
	/** Whether the signature verified as the server-authenticated sender's. */
	verified: boolean;
	/** Sender handle (or agent UUID fallback), for the resumed step's context. */
	from: string;
	/** The inbound message id, for the step's threading/audit. */
	messageId: string;
}
