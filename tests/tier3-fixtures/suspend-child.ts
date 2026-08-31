/**
 * Process A of the cross-process resume test (fresh child): run the delegate
 * workflow to SUSPENSION against a shared libsql snapshot file, then map
 * `(handle, conversation) → runId` into a durable `SqliteThreadMap` so a
 * separate process can resolve + resume it.
 *
 * Args: <snapshotDbUrl> <threadMapUrl> <firstPassMarker> <resumeMarker> <handle> <conversation>
 * Prints `RUNID::<runId>` on its own line for the parent to capture.
 */

import { SqliteThreadMap } from "../../src/threadmap.js";
import { buildMastra } from "./shared-workflow.js";

const [
	snapshotDbUrl,
	threadMapUrl,
	firstPassMarker,
	resumeMarker,
	handle,
	conversation,
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
const wf = mastra.getWorkflow("rineDelegateWorkflow");
const run = await wf.createRun();
const result = await run.start({
	inputData: { to: "@bob", body: "please confirm" },
});

if (result.status !== "suspended") {
	console.error(`expected suspended, got ${result.status}`);
	process.exit(3);
}

const threadMap = await SqliteThreadMap.open({ url: threadMapUrl });
await threadMap.set(handle, conversation, run.runId);
threadMap.close();

console.log(`RUNID::${run.runId}`);
process.exit(0);
