/**
 * Tier-3 true idle-wake (SPEC §9, the differentiator).
 *
 * AC-12 (BLOCKING, the headline): suspend a Mastra workflow in ONE process,
 * resume it in a FRESH child process through the production `RineThreadResumer`
 * + `SqliteThreadMap` (same libsql files), and assert the run CONTINUES from the
 * suspended step (the pre-suspend body did NOT re-run) and that `resumeData`
 * carried ONLY plaintext (I-2 — no ciphertext).
 *
 * Plus unit coverage: `SqliteThreadMap` round-trip, and `handleInbound`
 * skip-paths (no-map / not-suspended / decrypt-failed → no ack, lossless).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RineThreadResumer } from "../src/inbound.js";
import { InMemoryThreadMap, SqliteThreadMap } from "../src/threadmap.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const SENTINEL = "SENTINEL_CIPHERTEXT_DO_NOT_LEAK_0xDEADBEEF";

/** A fixture child's captured output (stdout/stderr coerced to strings). */
interface ChildResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Run a fixture child in a FRESH node+tsx process (cross-process boundary). */
function runChild(script: string, args: string[]): ChildResult {
	const r = spawnSync(
		process.execPath,
		["--import", "tsx", resolve(here, "tier3-fixtures", script), ...args],
		{ cwd: pkgRoot, encoding: "utf-8", timeout: 60_000 },
	);
	return {
		status: r.status,
		stdout: String(r.stdout ?? ""),
		stderr: String(r.stderr ?? ""),
	};
}

/** Number of lines the (cross-process-written) first-pass marker holds. */
function firstPassLines(marker: string): number {
	return readFileSync(marker, "utf-8").trim().split("\n").length;
}

describe("AC-12 — cross-process suspend→resume CONTINUES (the headline)", () => {
	let dir: string;
	let snapshotUrl: string;
	let threadMapUrl: string;
	let firstPassMarker: string;
	let resumeMarker: string;
	const handle = "bob@acme.rine.network";
	const conversation = "conv-ac12";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rine-mastra-tier3-"));
		snapshotUrl = `file:${join(dir, "snapshot.db")}`;
		threadMapUrl = `file:${join(dir, "threadmap.db")}`;
		firstPassMarker = join(dir, "first-pass.log");
		resumeMarker = join(dir, "resume-data.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("resumes from the suspended step in a fresh process, plaintext-only resumeData", () => {
		// PROCESS A: suspend + persist (handle, conversation) → runId.
		const a = runChild("suspend-child.ts", [
			snapshotUrl,
			threadMapUrl,
			firstPassMarker,
			resumeMarker,
			handle,
			conversation,
		]);
		expect(a.stderr ?? "").not.toMatch(/Error|expected/i);
		expect(a.status).toBe(0);
		const runId = (a.stdout.match(/RUNID::(\S+)/) ?? [])[1];
		expect(
			runId,
			`process A stdout: ${a.stdout}\nstderr: ${a.stderr}`,
		).toBeTruthy();

		// The pre-suspend body ran exactly once in process A.
		expect(firstPassLines(firstPassMarker)).toBe(1);

		// PROCESS B (FRESH): resume via the resumer + store. The carried sentinel
		// ciphertext must NEVER appear in resumeData.
		const b = runChild("resume-child.ts", [
			snapshotUrl,
			threadMapUrl,
			firstPassMarker,
			resumeMarker,
			handle,
			conversation,
			SENTINEL,
		]);
		expect(b.stderr ?? "").not.toMatch(/Error|missing args/i);
		expect(b.status).toBe(0);

		const outcome = JSON.parse(
			(b.stdout.match(/OUTCOME::(.+)/) ?? [])[1] ?? "{}",
		);
		expect(
			outcome,
			`process B stdout: ${b.stdout}\nstderr: ${b.stderr}`,
		).toEqual({
			resumed: true,
			runId,
		});

		// CONTINUES, not restarts: the pre-suspend body did NOT re-run in process B
		// (the marker still holds exactly one line).
		expect(firstPassLines(firstPassMarker)).toBe(1);

		// I-2: resumeData carried ONLY plaintext + signature facts; the ciphertext
		// sentinel never reached the resumed step.
		expect(existsSync(resumeMarker)).toBe(true);
		const resumeData = JSON.parse(readFileSync(resumeMarker, "utf-8"));
		expect(resumeData).toEqual({
			plaintext: "confirmed!",
			verified: true,
			from: handle,
			messageId: "msg-ac12-0001",
		});
		expect(JSON.stringify(resumeData)).not.toContain(SENTINEL);
		expect(JSON.stringify(resumeData)).not.toContain("encrypted_payload");
	});
});

describe("SqliteThreadMap — durable (handle, conversation) → runId round-trip", () => {
	it("set/get/delete a mapping in-memory", async () => {
		const store = await SqliteThreadMap.open({ url: ":memory:" });
		expect(await store.get("a@x", "c1")).toBeUndefined();

		await store.set("a@x", "c1", "run-1");
		await store.set("b@y", "c2", "run-2");
		expect(await store.get("a@x", "c1")).toBe("run-1");
		expect(await store.get("b@y", "c2")).toBe("run-2");

		// Remap is an upsert (latest wins), not a duplicate row.
		await store.set("a@x", "c1", "run-3");
		expect(await store.get("a@x", "c1")).toBe("run-3");

		await store.delete("a@x", "c1");
		expect(await store.get("a@x", "c1")).toBeUndefined();
		// Unrelated mapping survives the delete.
		expect(await store.get("b@y", "c2")).toBe("run-2");
		store.close();
	});

	it("persists across re-open of the SAME file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rine-mastra-tmap-"));
		const url = `file:${join(dir, "map.db")}`;
		try {
			const first = await SqliteThreadMap.open({ url });
			await first.set("c@z", "conv-9", "run-9");
			first.close();

			const reopened = await SqliteThreadMap.open({ url });
			expect(await reopened.get("c@z", "conv-9")).toBe("run-9");
			reopened.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("RineThreadResumer.handleInbound — skip paths never ack (lossless)", () => {
	/** A fake workflow whose snapshot status + resume calls are observable. */
	function fakeWorkflow(status: string | null) {
		const resume = vi.fn<
			(p: { step?: unknown; resumeData: unknown }) => Promise<unknown>
		>(async () => undefined);
		const createRun = vi.fn(async () => ({ resume }));
		const getWorkflowRunById = vi.fn(async () =>
			status === null ? null : { status },
		);
		return { workflow: { getWorkflowRunById, createRun }, resume, createRun };
	}

	function inbound(over: Record<string, unknown> = {}) {
		return {
			id: "m1",
			conversation_id: "c1",
			sender_handle: "bob@acme",
			from_agent_id: "33333333-3333-4333-8333-333333333333",
			type: "rine.v1.text",
			encrypted_payload: SENTINEL,
			encryption_version: "hpke-v1",
			metadata: {},
			created_at: "2026-06-11T00:00:00Z",
			plaintext: { text: "hi" },
			verified: true,
			verification_status: "verified",
			...over,
			// biome-ignore lint/suspicious/noExplicitAny: synthetic fixture
		} as any;
	}

	const quietLogger = { debug: vi.fn(), warn: vi.fn() };

	it("no mapped run → skip, never resumes, never acks", async () => {
		const f = fakeWorkflow("suspended");
		const resumer = new RineThreadResumer({
			workflow: f.workflow,
			threadMap: new InMemoryThreadMap(), // empty: no mapping
			logger: quietLogger,
		});
		const out = await resumer.handleInbound(inbound());
		expect(out).toEqual({ resumed: false, reason: "no-map" });
		expect(f.workflow.getWorkflowRunById).not.toHaveBeenCalled();
		expect(f.resume).not.toHaveBeenCalled();
	});

	it("mapped run not suspended → skip, never resumes", async () => {
		const f = fakeWorkflow("success"); // completed, not waiting
		const map = new InMemoryThreadMap();
		await map.set("bob@acme", "c1", "run-x");
		const resumer = new RineThreadResumer({
			workflow: f.workflow,
			threadMap: map,
			logger: quietLogger,
		});
		const out = await resumer.handleInbound(inbound());
		expect(out).toEqual({ resumed: false, reason: "not-suspended" });
		expect(f.workflow.getWorkflowRunById).toHaveBeenCalledWith("run-x");
		expect(f.resume).not.toHaveBeenCalled();
	});

	it("missing snapshot (run gone) → skip, never resumes", async () => {
		const f = fakeWorkflow(null);
		const map = new InMemoryThreadMap();
		await map.set("bob@acme", "c1", "run-x");
		const resumer = new RineThreadResumer({
			workflow: f.workflow,
			threadMap: map,
			logger: quietLogger,
		});
		const out = await resumer.handleInbound(inbound());
		expect(out).toEqual({ resumed: false, reason: "not-suspended" });
		expect(f.resume).not.toHaveBeenCalled();
	});

	it("missing (handle, conversation) → no-conversation skip, never touches the store", async () => {
		const f = fakeWorkflow("suspended");
		const map = new InMemoryThreadMap();
		await map.set("bob@acme", "c1", "run-x");
		const resumer = new RineThreadResumer({
			workflow: f.workflow,
			threadMap: map,
			logger: quietLogger,
		});
		// No conversation_id → no-conversation skip.
		const noConv = await resumer.handleInbound(
			inbound({ conversation_id: undefined }),
		);
		expect(noConv).toEqual({ resumed: false, reason: "no-conversation" });
		// No sender identity at all (both handle fields null) → no-conversation skip.
		const noSender = await resumer.handleInbound(
			inbound({ sender_handle: null, from_agent_id: null }),
		);
		expect(noSender).toEqual({ resumed: false, reason: "no-conversation" });
		// Neither path looked up a run.
		expect(f.workflow.getWorkflowRunById).not.toHaveBeenCalled();
		expect(f.resume).not.toHaveBeenCalled();
	});

	it("from_agent_id keys the thread map when sender_handle is null", async () => {
		const f = fakeWorkflow("suspended");
		const map = new InMemoryThreadMap();
		const agentUuid = "33333333-3333-4333-8333-333333333333";
		// The run is mapped under the from_agent_id fallback, not a human handle.
		await map.set(agentUuid, "c1", "run-fallback");
		const resumer = new RineThreadResumer({
			workflow: f.workflow,
			threadMap: map,
			logger: quietLogger,
		});
		const out = await resumer.handleInbound(
			inbound({ sender_handle: null, from_agent_id: agentUuid }),
		);
		// The from_agent_id fallback resolved the mapped run and resumed it.
		expect(out).toEqual({ resumed: true, runId: "run-fallback" });
		expect(f.workflow.getWorkflowRunById).toHaveBeenCalledWith("run-fallback");
		const resumeData = f.resume.mock.calls[0]?.[0]?.resumeData;
		expect(resumeData).toMatchObject({ from: agentUuid });
	});

	it("REQ-CTX-02: resumeData injects NO rine transcript (no double-context)", async () => {
		// mastra relies on the durable host session store + the pull tool, NOT a
		// pushed transcript. The resumed step gets ONLY plaintext + signature facts.
		const f = fakeWorkflow("suspended");
		const map = new InMemoryThreadMap();
		await map.set("bob@acme", "c1", "run-x");
		const resumer = new RineThreadResumer({
			workflow: f.workflow,
			threadMap: map,
			logger: quietLogger,
		});
		const out = await resumer.handleInbound(inbound());
		expect(out).toEqual({ resumed: true, runId: "run-x" });
		const resumeData = f.resume.mock.calls[0]?.[0]?.resumeData as Record<
			string,
			unknown
		>;
		// Exactly the four documented keys — no `transcript`/`context`/`thread`.
		expect(Object.keys(resumeData).sort()).toEqual([
			"from",
			"messageId",
			"plaintext",
			"verified",
		]);
		expect(resumeData).not.toHaveProperty("transcript");
		expect(resumeData).not.toHaveProperty("context");
		expect(resumeData).not.toHaveProperty("thread");
	});

	it("resume that throws → failed skip, lossless (no ack, no crash)", async () => {
		// A transient storage error or a throwing resumed step must NOT propagate
		// (I-3) — it degrades to a lossless skip so the message stays in the inbox.
		const map = new InMemoryThreadMap();
		await map.set("bob@acme", "c1", "run-x");
		const resume = vi.fn(async () => {
			throw new Error("transient libsql error");
		});
		const workflow = {
			getWorkflowRunById: vi.fn(async () => ({ status: "suspended" })),
			createRun: vi.fn(async () => ({ resume })),
		};
		const resumer = new RineThreadResumer({
			workflow,
			threadMap: map,
			logger: quietLogger,
		});
		const out = await resumer.handleInbound(inbound());
		expect(out).toEqual({ resumed: false, reason: "failed" });
		expect(resume).toHaveBeenCalledTimes(1);
	});

	it("decrypt-failed message → skip BEFORE any run lookup, never acks", async () => {
		const f = fakeWorkflow("suspended");
		const map = new InMemoryThreadMap();
		await map.set("bob@acme", "c1", "run-x");
		const resumer = new RineThreadResumer({
			workflow: f.workflow,
			threadMap: map,
			logger: quietLogger,
		});
		const out = await resumer.handleInbound(
			inbound({ decrypt_error: "unknown encryption_version", plaintext: null }),
		);
		expect(out).toEqual({ resumed: false, reason: "decrypt-failed" });
		// Decrypt-failed short-circuits — no store/run access at all.
		expect(f.workflow.getWorkflowRunById).not.toHaveBeenCalled();
		expect(f.resume).not.toHaveBeenCalled();
	});

	it("suspended run mapped → resumes with plaintext-only resumeData (I-2)", async () => {
		const f = fakeWorkflow("suspended");
		const map = new InMemoryThreadMap();
		await map.set("bob@acme", "c1", "run-x");
		const resumer = new RineThreadResumer({
			workflow: f.workflow,
			threadMap: map,
			step: "wait-step",
			logger: quietLogger,
		});
		const out = await resumer.handleInbound(inbound());
		expect(out).toEqual({ resumed: true, runId: "run-x" });
		expect(f.createRun).toHaveBeenCalledWith({ runId: "run-x" });
		expect(f.resume).toHaveBeenCalledTimes(1);

		const resumeData = f.resume.mock.calls[0]?.[0]?.resumeData;
		expect(resumeData).toEqual({
			plaintext: "hi",
			verified: true,
			from: "bob@acme",
			messageId: "m1",
		});
		// I-2: the carried ciphertext sentinel never enters resumeData.
		expect(JSON.stringify(resumeData)).not.toContain(SENTINEL);
	});
});
