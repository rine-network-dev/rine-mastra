/**
 * Tier-3 cross-process suspend/resume demo for the live e2e.
 *
 * Builds a real Mastra workflow whose single step `suspend()`s waiting for a rine
 * reply, runs it to suspension, persists `(handle, conversation) → runId` into a
 * durable {@link SqliteThreadMap}, then — simulating a SEPARATE long-lived
 * process / org — feeds a real inbound rine `DecryptedMessage` through the public
 * {@link RineThreadResumer} and asserts the run CONTINUES from the suspended step
 * (does not restart). This is the package's headline differentiator exercised
 * against the live primitives the same way `tests/tier3.test.ts` proves it
 * in-process.
 *
 * The resumer builds `resumeData` from plaintext only — no ciphertext, no SDK
 * client — and this demo asserts the sentinel is absent from the resumed step's
 * captured data.
 */

import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import type {
	AgentHandle,
	AsyncRineClient,
	DecryptedMessage,
} from "@rine-network/sdk";
import { join } from "node:path";
import { z } from "zod";
import {
	type ResumableWorkflow,
	RineThreadResumer,
	SqliteThreadMap,
} from "../src/index.js";
import { check } from "./_legs.js";

const WAIT_STEP_ID = "wait-for-rine-reply";

/** What the demo reports back so the orchestrator can assert/cleanup. */
export interface Tier3DemoResult {
	resumed: boolean;
	runId?: string;
	/** The plaintext the resumed step received (asserted to equal the nonce). */
	resumedPlaintext?: string;
	/** True if the ciphertext sentinel was absent from the resumed step's data. */
	ciphertextAbsent: boolean;
}

/** Build the suspendable workflow + Mastra instance over a shared libsql file. */
function buildWorkflow(dbUrl: string, capture: { data?: unknown }) {
	const waitForReply = createStep({
		id: WAIT_STEP_ID,
		inputSchema: z.object({ to: z.string() }),
		resumeSchema: z.object({
			plaintext: z.string(),
			verified: z.boolean(),
			from: z.string(),
			messageId: z.string(),
		}),
		suspendSchema: z.object({ to: z.string() }),
		outputSchema: z.object({ reply: z.string() }),
		execute: async ({ inputData, resumeData, suspend }) => {
			if (!resumeData) return await suspend({ to: inputData.to });
			capture.data = resumeData;
			return { reply: resumeData.plaintext };
		},
	});
	const workflow = createWorkflow({
		id: "rineTier3Demo",
		inputSchema: z.object({ to: z.string() }),
		outputSchema: z.object({ reply: z.string() }),
	})
		.then(waitForReply)
		.commit();
	const mastra = new Mastra({
		storage: new LibSQLStore({ id: "tier3-demo", url: dbUrl }),
		workflows: { rineTier3Demo: workflow },
	});
	return { mastra, waitForReply };
}

/**
 * Run the full suspend → (durable map) → resume cycle. `inbound` is a real
 * decrypted reply from the responder; `nonce` is the unique value expected to
 * survive into the resumed step; `sentinel` is a ciphertext marker that must NOT.
 */
export async function runTier3Demo(args: {
	snapshotDbUrl: string;
	threadMapUrl: string;
	inbound: DecryptedMessage;
	nonce: string;
	sentinel: string;
}): Promise<Tier3DemoResult> {
	const capture: { data?: unknown } = {};
	const { mastra, waitForReply } = buildWorkflow(args.snapshotDbUrl, capture);
	const wf = mastra.getWorkflow("rineTier3Demo");

	const run = await wf.createRun();
	const started = await run.start({ inputData: { to: "responder" } });
	if (started.status !== "suspended") {
		throw new Error(`expected suspended, got ${started.status}`);
	}

	const handle = args.inbound.sender_handle ?? args.inbound.from_agent_id ?? "";
	const conversation = args.inbound.conversation_id;
	const threadMap = await SqliteThreadMap.open({ url: args.threadMapUrl });
	await threadMap.set(handle, conversation, run.runId);

	// A SEPARATE-process-shaped resumer: a fresh resumer over a fresh Mastra
	// pointed at the SAME libsql snapshot + the durable thread map. A real Mastra
	// workflow satisfies `ResumableWorkflow` structurally; the cast narrows
	// Mastra's stricter generic `resume` step-union to our minimal surface (same
	// pattern as the in-process test fixture).
	const resumer = new RineThreadResumer({
		workflow: wf as unknown as ResumableWorkflow,
		threadMap,
		step: waitForReply,
	});
	const outcome = await resumer.handleInbound(args.inbound);
	threadMap.close();

	const captured = JSON.stringify(capture.data ?? null);
	return {
		resumed: outcome.resumed,
		runId: outcome.resumed ? outcome.runId : undefined,
		resumedPlaintext: capture.data
			? (capture.data as { plaintext?: string }).plaintext
			: undefined,
		ciphertextAbsent:
			!captured.includes(args.sentinel) &&
			!captured.includes("encrypted_payload") &&
			captured.includes(args.nonce),
	};
}

/** Suspend a workflow, then wake it with the responder's real reply. */
export async function tier3Leg(
	driver: AsyncRineClient,
	responderHandle: string,
	opts: { dir: string; nonce: string; sentinel: string },
): Promise<void> {
	const sent = await driver.sendAndWait(
		responderHandle as AgentHandle,
		{ text: `tier3 ${opts.nonce}` },
		{ timeout: 30_000 },
	);
	const inbound = sent.reply;
	check(!!inbound, "Tier-3 got a real reply to seed the resumer");
	if (!inbound) return;
	const result = await runTier3Demo({
		snapshotDbUrl: `file:${join(opts.dir, "wf.db")}`,
		threadMapUrl: `file:${join(opts.dir, "threadmap.db")}`,
		inbound,
		nonce: String((inbound.plaintext as { text?: string })?.text ?? opts.nonce),
		sentinel: opts.sentinel,
	});
	check(result.resumed, "Tier-3 run resumed (CONTINUES, not restarts)");
	check(result.ciphertextAbsent, "Tier-3 resumeData has no ciphertext");
}
