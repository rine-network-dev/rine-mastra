/**
 * Shared workflow + Mastra-instance factory for the cross-process resume test
 * (adapted from `_probe/p10_shared.ts`). Both the suspend child and the resume
 * driver import this so they build an IDENTICAL workflow/Mastra wired to the
 * SAME libsql snapshot file (shared storage).
 *
 * The pre-suspend body APPENDS to a side-channel marker file so the test can
 * prove, from a fresh process, that the send/suspend body did NOT re-run on
 * resume (the run CONTINUES from the suspended step, it does not restart). It
 * also records the `resumeData` it received so the test can assert it carried
 * only plaintext / verified / from — never ciphertext.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { z } from "zod";

/** The step a `RineThreadResumer` resumes — its id is the suspended step path. */
export const WAIT_STEP_ID = "wait-for-rine-reply";

/** The resumeData shape the resumer builds: plaintext + signature facts only. */
const resumeSchema = z.object({
	plaintext: z.string(),
	verified: z.boolean(),
	from: z.string(),
	messageId: z.string(),
});

/** Build the wait-step bound to the given marker files. */
function buildStep(firstPassMarker: string, resumeMarker: string) {
	return createStep({
		id: WAIT_STEP_ID,
		inputSchema: z.object({ to: z.string(), body: z.string() }),
		resumeSchema,
		suspendSchema: z.object({ conversationId: z.string(), to: z.string() }),
		outputSchema: z.object({ replyText: z.string(), from: z.string() }),
		execute: async ({ inputData, resumeData, suspend }) => {
			if (!resumeData) {
				// First pass: record that the pre-suspend body ran, then suspend.
				appendFileSync(firstPassMarker, "first-pass\n");
				return await suspend({ conversationId: "conv-ac12", to: inputData.to });
			}
			// Resumed: capture exactly what resumeData carried, for the
			// ciphertext-absent assertion.
			writeFileSync(resumeMarker, JSON.stringify(resumeData));
			return { replyText: resumeData.plaintext, from: resumeData.from };
		},
	});
}

/** Build a Mastra instance + the delegate workflow over the shared snapshot DB. */
export function buildMastra(
	dbUrl: string,
	firstPassMarker: string,
	resumeMarker: string,
) {
	const waitForReply = buildStep(firstPassMarker, resumeMarker);
	const rineDelegateWorkflow = createWorkflow({
		id: "rineDelegateWorkflow",
		inputSchema: z.object({ to: z.string(), body: z.string() }),
		outputSchema: z.object({ replyText: z.string(), from: z.string() }),
	})
		.then(waitForReply)
		.commit();

	const mastra = new Mastra({
		storage: new LibSQLStore({ id: "ac12-store", url: dbUrl }),
		workflows: { rineDelegateWorkflow },
	});
	return { mastra, waitForReply, rineDelegateWorkflow };
}
