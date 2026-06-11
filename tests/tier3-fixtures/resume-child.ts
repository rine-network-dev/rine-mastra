/**
 * AC-12 process B (FRESH process, empty in-memory run-map): wake the suspended
 * run THROUGH the production `RineThreadResumer` + `SqliteThreadMap`, exactly as
 * a wake driver would. Proves cross-process continuation (#5521/#4630 defended)
 * AND that the resumer resolves `(handle, conversation) → runId` from the durable
 * store, rehydrates via `getWorkflowRunById` before resume, and builds resumeData
 * from plaintext only (I-2).
 *
 * Args: <snapshotDbUrl> <threadMapUrl> <firstPassMarker> <resumeMarker> <handle> <conversation> <sentinelCiphertext>
 * Prints `OUTCOME::<json>`.
 */

import type { ResumableWorkflow } from "../../src/inbound.js";
import { RineThreadResumer } from "../../src/inbound.js";
import { SqliteThreadMap } from "../../src/threadmap.js";
import { WAIT_STEP_ID, buildMastra } from "./shared-workflow.js";

const [
	snapshotDbUrl,
	threadMapUrl,
	firstPassMarker,
	resumeMarker,
	handle,
	conversation,
	sentinelCiphertext,
] = process.argv.slice(2);

if (!snapshotDbUrl || !threadMapUrl || !handle || !conversation) {
	console.error("missing args");
	process.exit(2);
}

const { mastra } = buildMastra(
	snapshotDbUrl,
	firstPassMarker as string,
	resumeMarker as string,
);
// A real Mastra workflow satisfies ResumableWorkflow structurally at runtime
// (getWorkflowRunById + createRun({runId}).resume({step,resumeData})); the cast
// narrows Mastra's stricter generic `resume` step-union to our minimal surface.
const workflow = mastra.getWorkflow(
	"rineDelegateWorkflow",
) as unknown as ResumableWorkflow;
const threadMap = await SqliteThreadMap.open({ url: threadMapUrl });

const resumer = new RineThreadResumer({
	workflow,
	threadMap,
	step: WAIT_STEP_ID,
});

// A synthetic inbound message as a wake driver would hand it over. It carries a
// SENTINEL ciphertext envelope field that must NEVER reach resumeData (I-2); the
// resumer reads only plaintext/verified/sender_handle/conversation_id.
const inbound = {
	id: "msg-ac12-0001",
	conversation_id: conversation as string,
	sender_handle: handle as string,
	from_agent_id: "33333333-3333-4333-8333-333333333333",
	type: "rine.v1.task_response",
	encrypted_payload: sentinelCiphertext as string,
	encryption_version: "hpke-v1",
	metadata: {},
	created_at: new Date().toISOString(),
	plaintext: { text: "confirmed!" },
	verified: true,
	verification_status: "verified" as const,
};

// biome-ignore lint/suspicious/noExplicitAny: synthetic DecryptedMessage fixture
const outcome = await resumer.handleInbound(inbound as any);
threadMap.close();

console.log(`OUTCOME::${JSON.stringify(outcome)}`);
process.exit(0);
