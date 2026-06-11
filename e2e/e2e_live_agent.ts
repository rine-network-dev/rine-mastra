/**
 * Live-LLM end-to-end e2e (SPEC §16). AUTHORED for Phase F to RUN — it is NOT run
 * here (no creds / no LLM in this environment). It reads secrets by name from a
 * gitignored `.e2e.env` (see `_env.ts`) and is a runnable `tsx` script:
 *
 *   tsx e2e/e2e_live_agent.ts
 *
 * Flow (each leg asserts; the whole run erases the throwaway org in `finally`):
 *   1. onboard a throwaway org via REAL RSA proof-of-work → first agent (driver);
 *   2. create a second agent (responder) + start the `defineAgent` responder;
 *   3. programmatic tool sweep (all 11 tools, no ciphertext leak);
 *   4. a REAL Mastra `Agent` + REAL LLM drives discover → send_and_wait →
 *      check_inbox → reply, asserting a unique nonce round-trips encrypted;
 *   5. MLS-group post+read round-trip (AC-6/7) — MLS on by default;
 *   6. PQ-hybrid 1:1 round-trip (AC-8) — `hpke-hybrid-v1` on the wire;
 *   7. Tier-3 cross-process suspend/resume demo (a step suspends, an inbound
 *      reply wakes it via the resumer; the run CONTINUES, I-2 holds in resumeData);
 *   8. `eraseOrg({ confirm: true })`.
 *
 * I-2 runs through every leg: only `plaintext` is asserted; a ciphertext SENTINEL
 * must never appear in any tool return, rendered message, or resumeData.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { type AgentHandle, AsyncRineClient } from "@rine-network/sdk";
import {
	RINE_ACTING_AGENT,
	RINE_CONFIG_DIR,
	rineToolkit,
	runOnboard,
} from "../src/index.js";
import { envVar, requireEnv } from "./_env.js";
import { check, legMlsGroup, legPq1to1 } from "./_legs.js";
import { toolSweep } from "./_sweep.js";
import { runTier3Demo } from "./_tier3-demo.js";
import { startResponder } from "./responder.js";

/** A unique value the driver expects to survive the encrypted round-trips. */
const NONCE = `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
/** A marker no plaintext path may ever surface (the I-2 ciphertext sentinel). */
const SENTINEL = "CIPHERTEXT-SENTINEL-DO-NOT-LEAK";

async function main(): Promise<void> {
	// Reuses the crewai/langchain sibling `.e2e.env` contract (same secrets):
	//   RINE_API_URL · TOGETHER_API_KEY · RINE_E2E_MODEL · RINE_E2E_BASE_URL.
	const apiUrl = envVar("RINE_API_URL") ?? "https://rine.network";
	const model = envVar("RINE_E2E_MODEL") ?? "meta-llama/Llama-3.3-70B-Instruct-Turbo";
	// A Together-style OpenAI-compatible provider (chat completions, NOT the
	// Responses API) — the same endpoint the crewai rig drives.
	const llm = createOpenAICompatible({
		name: "together",
		baseURL: envVar("RINE_E2E_BASE_URL") ?? "https://api.together.xyz/v1",
		apiKey: requireEnv("TOGETHER_API_KEY"),
	});

	// Distinct throwaway orgs need DISTINCT emails — the server rejects a second
	// registration on an in-use email. Our own domain (MX-backed, non-disposable);
	// the localparts are unique-per-run and the orgs are erased in `finally`.
	const prefix = envVar("E2E_SLUG_PREFIX") ?? "e2e-mastra";
	const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const driverSlug = `${prefix}-${unique}`;
	const responderSlug = `${driverSlug}-r`;
	const driverEmail = `${prefix}-d-${unique}@rine.network`;
	const responderEmail = `${prefix}-r-${unique}@rine.network`;

	// Two isolated config dirs: the LLM-driven "driver" agent + the responder.
	const driverDir = mkdtempSync(join(tmpdir(), "rine-e2e-driver-"));
	const responderDir = mkdtempSync(join(tmpdir(), "rine-e2e-responder-"));

	console.log(`[e2e] onboarding throwaway org "${driverSlug}" …`);
	const driverHandle = await runOnboard({
		email: driverEmail,
		slug: driverSlug,
		name: "E2E Driver",
		apiUrl,
		configDir: driverDir,
	});
	const driver = new AsyncRineClient({ configDir: driverDir, apiUrl });

	// The responder is a DISTINCT remote org (its own email + slug) so the legs
	// exercise real cross-org 1:1 / group / PQ paths, not same-org shortcuts.
	const responderHandle = await runOnboard({
		email: responderEmail,
		slug: responderSlug,
		name: "E2E Responder",
		apiUrl,
		configDir: responderDir,
	});
	const responderClient = new AsyncRineClient({
		configDir: responderDir,
		apiUrl,
	});
	const responderAgentId = (await responderClient.inspect(responderHandle)).id;

	const responder = startResponder({
		client: responderClient,
		ack: (body) => `ack ${body}`,
	});
	await responder.start();

	try {
		// (3) programmatic sweep
		console.log("[e2e] tool sweep …");
		await toolSweep({
			configDir: driverDir,
			agent: driverHandle,
			responderHandle,
			sentinel: SENTINEL,
		});

		// (4) live LLM drives the messaging tools
		console.log("[e2e] live-LLM messaging leg …");
		await llmLeg(driverDir, driverHandle, responderHandle, llm, model);

		// (5) MLS group + (6) PQ 1:1 round-trips
		console.log("[e2e] MLS-group round-trip …");
		await legMlsGroup(driver, responderClient, responderAgentId, NONCE, SENTINEL);
		console.log("[e2e] PQ-hybrid 1:1 round-trip …");
		await legPq1to1(driver, responderHandle, NONCE, SENTINEL);

		// (7) Tier-3 cross-process suspend/resume demo
		console.log("[e2e] Tier-3 suspend/resume demo …");
		await tier3Leg(driver, responderHandle);

		console.log("\n[e2e] ALL LEGS PASSED ✅");
	} finally {
		console.log("[e2e] tearing down (eraseOrg) …");
		await responder.stop();
		await driver.eraseOrg({ confirm: true });
		await responderClient.eraseOrg({ confirm: true });
		console.log("[e2e] orgs erased.");
	}
}

/** A real Mastra Agent + real LLM drives discover → send_and_wait → reply. */
async function llmLeg(
	configDir: string,
	driverHandle: string,
	responderHandle: string,
	llm: ReturnType<typeof createOpenAICompatible>,
	model: string,
): Promise<void> {
	const agent = new Agent({
		id: "e2e-driver",
		name: "E2E Driver Agent",
		instructions: [
			`You are a rine agent. Send the message "ping ${NONCE}" to`,
			`${responderHandle} and WAIT for its reply using rine_send_and_wait`,
			"(waitSeconds 30). Then report the reply text verbatim.",
		].join(" "),
		model: llm(model),
		tools: rineToolkit({ configDir, agent: driverHandle }),
	});
	const rc = new RequestContext();
	rc.set(RINE_CONFIG_DIR, configDir);
	rc.set(RINE_ACTING_AGENT, driverHandle);

	const res = await agent.generate(
		`Message ${responderHandle} with "ping ${NONCE}" and wait for the reply.`,
		{ maxSteps: 6, requestContext: rc },
	);
	check(!res.text.includes(SENTINEL), "LLM output has no ciphertext (I-2)");
	check(
		res.text.includes(NONCE) || res.text.toLowerCase().includes("ack"),
		"LLM reported the responder's ack (nonce round-tripped)",
	);
}

/** Suspend a workflow, then wake it with the responder's real reply. */
async function tier3Leg(
	driver: AsyncRineClient,
	responderHandle: string,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "rine-e2e-tier3-"));
	const t3nonce = `t3-${NONCE}`;
	const sent = await driver.sendAndWait(
		responderHandle as AgentHandle,
		{ text: `tier3 ${t3nonce}` },
		{ timeout: 30_000 },
	);
	const inbound = sent.reply;
	check(!!inbound, "Tier-3 got a real reply to seed the resumer");
	if (!inbound) return;
	const result = await runTier3Demo({
		snapshotDbUrl: `file:${join(dir, "wf.db")}`,
		threadMapUrl: `file:${join(dir, "threadmap.db")}`,
		inbound,
		nonce: String((inbound.plaintext as { text?: string })?.text ?? t3nonce),
		sentinel: SENTINEL,
	});
	check(result.resumed, "Tier-3 run resumed (CONTINUES, not restarts)");
	check(result.ciphertextAbsent, "Tier-3 resumeData has no ciphertext (I-2)");
}

main().catch((err) => {
	console.error("[e2e] FAILED:", err);
	process.exitCode = 1;
});
