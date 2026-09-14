/**
 * The set-aside store and what the resumer records into it.
 *
 * What this exists to catch: the driver is an SSE loop, and the rine server
 * marks a streamed frame delivered as it yields it — so a message the resumer
 * skipped has already been consumed, and the recorded id is the only thing left
 * to retry it by. Before this store there was none, and the package documented
 * the opposite ("lossless — a later poll can retry"). Every assertion here is
 * about the id being written down, the bound that stops it being retried
 * forever, and the one class that must never be retried at all.
 *
 * The retry that spends these records is `setaside-sweep.test.ts`.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	SETASIDE_MAX_ATTEMPTS,
	SETASIDE_MAX_ENTRIES,
} from "../src/constants.js";
import { RineThreadResumer } from "../src/inbound.js";
import { SqliteSetAside } from "../src/setaside-sqlite.js";
import {
	InMemorySetAside,
	groupSyncMayHeal,
	isGone,
	isPermanentSetAside,
	sightingOf,
} from "../src/setaside.js";
import type {
	ResumeSkipReason,
	SetAsideEntry,
	SetAsideSighting,
	SetAsideStore,
} from "../src/setaside.js";
import { InMemoryThreadMap } from "../src/threadmap.js";
import { makeInbound } from "./harness.js";

const GROUP_ID = "44444444-4444-4444-8444-444444444444";

/** A store, plus whatever has to be released afterwards. */
type OpenStore = () => Promise<SetAsideStore & { close?: () => void }>;

/** Both implementations answer the same questions, so both take the same suite. */
const stores: Array<[string, OpenStore]> = [
	["InMemorySetAside", async () => new InMemorySetAside()],
	["SqliteSetAside", async () => SqliteSetAside.open({ url: ":memory:" })],
];

describe.each(stores)("%s — the store contract", (_name, open) => {
	it("records a skipped id without spending an attempt, however often it is re-sighted", async () => {
		const store = await open();
		const first = await store.record({
			id: "m1",
			reason: "no-map",
			groupId: null,
		});
		expect(first).toMatchObject({ id: "m1", attempts: 0, exhausted: false });

		// The live path parks a message, and the sweep's retry runs back through
		// that same path — so a still-unresumable message is re-recorded on every
		// sweep. If a re-record counted, the bound would be a count of SIGHTINGS
		// and a busy channel would exhaust a healable message in five frames.
		const again = await store.record({
			id: "m1",
			reason: "no-map",
			groupId: null,
		});
		expect(again.attempts).toBe(0);
		expect(again.firstSeen).toBe(first.firstSeen);
		expect((await store.due()).map((e) => e.id)).toEqual(["m1"]);
		store.close?.();
	});

	it("stops retrying after the attempt bound", async () => {
		const store = await open();
		await store.record({ id: "m1", reason: "decrypt-failed", groupId: null });
		let entry = (await store.due())[0] as SetAsideEntry;
		expect(entry).toBeDefined();
		for (let i = 1; i <= SETASIDE_MAX_ATTEMPTS; i += 1) {
			entry = await store.countAttempt(entry);
			expect(entry.attempts).toBe(i);
			expect(entry.exhausted).toBe(i >= SETASIDE_MAX_ATTEMPTS);
		}
		// Exhausted entries are no longer served: an unbounded retry would re-read
		// a permanently-unresumable message on every sweep forever.
		expect(await store.due()).toEqual([]);
		store.close?.();
	});

	it("never lowers an attempt count, so a re-record cannot re-arm the budget", async () => {
		const store = await open();
		await store.record({ id: "m1", reason: "no-map", groupId: null });
		const entry = (await store.due())[0] as SetAsideEntry;
		const spent = await store.countAttempt(entry);
		expect(spent.attempts).toBe(1);
		// The sweep's copy is stale (it was read before the retry): counting
		// against it must not roll the store back to 1 again, or a failing message
		// loops forever at attempt 1.
		const withStaleCopy = await store.countAttempt(entry);
		expect(withStaleCopy.attempts).toBe(2);
		store.close?.();
	});

	it("counts two overlapping attempts as two, not as one", async () => {
		// The sweep and the live inbound path share one store, and every merge is a
		// read-modify-write. Two that interleave read the same count and write the
		// same successor — a lost attempt is an unbounded retry loop, not a
		// cosmetic slip.
		const store = await open();
		await store.record({ id: "m1", reason: "failed", groupId: null });
		const entry = (await store.due())[0] as SetAsideEntry;
		await Promise.all([store.countAttempt(entry), store.countAttempt(entry)]);
		expect((await store.due())[0]?.attempts).toBe(2);
		store.close?.();
	});

	it("records an authenticity refusal already exhausted — recorded, never retried", async () => {
		const store = await open();
		const entry = await store.record({
			id: "m-forged",
			reason: "refused",
			groupId: GROUP_ID,
		});
		// Re-presenting attacker-controlled bytes on a timer is a log amplifier
		// whose cadence the attacker picks.
		expect(entry.exhausted).toBe(true);
		expect(await store.due()).toEqual([]);
		store.close?.();
	});

	it("a give-up is not undone by another sighting of the same message", async () => {
		const store = await open();
		await store.record({ id: "m1", reason: "failed", groupId: null });
		let entry = (await store.due())[0] as SetAsideEntry;
		for (let i = 0; i < SETASIDE_MAX_ATTEMPTS; i += 1) {
			entry = await store.countAttempt(entry);
		}
		expect(entry.exhausted).toBe(true);
		const resighted = await store.record({
			id: "m1",
			reason: "failed",
			groupId: null,
		});
		expect(resighted.exhausted).toBe(true);
		expect(await store.due()).toEqual([]);
		store.close?.();
	});

	it("caps at the capacity, dropping the oldest parked message", async () => {
		const store = await open();
		for (let i = 0; i <= SETASIDE_MAX_ENTRIES; i += 1) {
			await store.record({ id: `m${i}`, reason: "no-map", groupId: null });
		}
		// One over the cap. What the store costs a host is bounded by a number,
		// not by how long a group has been unreadable.
		const live = await store.due(SETASIDE_MAX_ENTRIES + 10);
		expect(live).toHaveLength(SETASIDE_MAX_ENTRIES);
		expect(live.map((e) => e.id)).not.toContain("m0");
		expect(live.map((e) => e.id)).toContain(`m${SETASIDE_MAX_ENTRIES}`);
		store.close?.();
	});

	it("evicts an exhausted entry before any live one", async () => {
		const store = await open();
		for (let i = 0; i < SETASIDE_MAX_ENTRIES; i += 1) {
			await store.record({ id: `m${i}`, reason: "no-map", groupId: null });
		}
		// Recorded LAST, so it is the YOUNGEST entry in the store: eviction by age
		// alone would spare it and take a live message's retry instead. An
		// exhausted entry is never retried, so all it loses by being dropped is
		// being counted.
		await store.record({ id: "gone", reason: "refused", groupId: null });
		const live = await store.due(SETASIDE_MAX_ENTRIES + 10);
		expect(live).toHaveLength(SETASIDE_MAX_ENTRIES);
		expect(live.map((e) => e.id)).toContain("m0");
		store.close?.();
	});

	it("serves the oldest entries first, at most the limit asked for", async () => {
		const store = await open();
		for (const id of ["a", "b", "c"]) {
			await store.record({ id, reason: "no-map", groupId: null });
		}
		expect((await store.due(2)).map((e) => e.id)).toEqual(["a", "b"]);
		store.close?.();
	});

	it("forgets one entry and leaves the rest", async () => {
		const store = await open();
		await store.record({ id: "a", reason: "no-map", groupId: GROUP_ID });
		await store.record({ id: "b", reason: "no-map", groupId: null });
		await store.forget("a");
		expect((await store.due()).map((e) => e.id)).toEqual(["b"]);
		store.close?.();
	});

	it("keeps the group id, which is what lets the retry sync before it reads", async () => {
		const store = await open();
		await store.record({ id: "a", reason: "decrypt-failed", groupId: GROUP_ID });
		expect((await store.due())[0]?.groupId).toBe(GROUP_ID);
		store.close?.();
	});
});

describe("SqliteSetAside — the durable half", () => {
	it("a parked message survives closing and re-opening the same file", async () => {
		// The whole point of the durable store: the in-memory one forgets a parked
		// message on restart, and the message it forgets was already consumed off
		// the stream, so nothing else remembers it either.
		const dir = mkdtempSync(join(tmpdir(), "rine-mastra-setaside-"));
		const url = `file:${join(dir, "setaside.db")}`;
		try {
			const first = await SqliteSetAside.open({ url });
			await first.record({
				id: "m-durable",
				reason: "decrypt-failed",
				groupId: GROUP_ID,
			});
			const spent = (await first.due())[0] as SetAsideEntry;
			await first.countAttempt(spent);
			first.close();

			const reopened = await SqliteSetAside.open({ url });
			const served = await reopened.due();
			expect(served).toHaveLength(1);
			expect(served[0]).toMatchObject({
				id: "m-durable",
				reason: "decrypt-failed",
				groupId: GROUP_ID,
				attempts: 1,
				exhausted: false,
			});
			expect(served[0]?.lastTried).toBeTypeOf("number");
			reopened.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// 🔴 A measured libsql trap, not a theoretical one: `Sqlite3Client.transaction`
	// hands its connection to the transaction and nulls its own handle, and nothing
	// ever closes the handed-over connection. The first cut of this store took one
	// write transaction per merge and leaked 499 file descriptors over 500 merges,
	// which a five-minute sweep of 50 parked messages turns into a 1024-fd limit
	// inside an hour — in a background timer, long after the change that caused it.
	it.skipIf(!existsSync("/proc/self/fd"))(
		"does not leak a file descriptor per merge",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "rine-mastra-setaside-fd-"));
			const store = await SqliteSetAside.open({
				url: `file:${join(dir, "fd.db")}`,
			});
			try {
				const openFds = () => readdirSync("/proc/self/fd").length;
				await store.record({ id: "warm", reason: "no-map", groupId: null });
				const before = openFds();
				for (let i = 0; i < 200; i += 1) {
					await store.record({ id: `m${i}`, reason: "no-map", groupId: null });
				}
				// A few fds can move for unrelated reasons (a file read, a vitest
				// socket); 200 merges must not move it by 200.
				expect(openFds() - before).toBeLessThan(20);
			} finally {
				store.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("sightingOf — which skips can be retried", () => {
	it("splits decrypt-failed by authenticity, not by one status spelling", () => {
		// `invalid` and `sender-mismatch` are BOTH authenticity verdicts. An
		// equality check against either one silently retries the other.
		for (const status of ["invalid", "sender-mismatch"]) {
			const sighting = sightingOf(
				makeInbound({ verification_status: status, decrypt_error: "refused" }),
				"decrypt-failed",
			);
			expect(sighting.reason).toBe("refused");
			expect(isPermanentSetAside(sighting.reason)).toBe(true);
		}
		// `unverifiable` is the absence of a verdict, not a finding against the
		// message — exactly the transient class the retry exists for.
		const unverifiable = sightingOf(
			makeInbound({
				verification_status: "unverifiable",
				decrypt_error: "sender key unavailable",
			}),
			"decrypt-failed",
		);
		expect(unverifiable.reason).toBe("decrypt-failed");
		expect(isPermanentSetAside(unverifiable.reason)).toBe(false);
	});

	it("carries the group id, and null for a 1:1 message", () => {
		expect(
			sightingOf(makeInbound({ group_id: GROUP_ID }), "decrypt-failed").groupId,
		).toBe(GROUP_ID);
		expect(sightingOf(makeInbound(), "no-map").groupId).toBeNull();
	});

	it("only a group decrypt failure is worth a sync before the retry", () => {
		// A sync installs sender keys and replays commits. The other skips never
		// reached the ciphertext, so there is nothing about the group to catch up.
		expect(groupSyncMayHeal("decrypt-failed")).toBe(true);
		for (const reason of [
			"refused",
			"no-map",
			"not-suspended",
			"no-conversation",
			"failed",
		] as const) {
			expect(groupSyncMayHeal(reason)).toBe(false);
		}
	});

	it("reads a gone row off the status field, and nothing else as gone", () => {
		// `instanceof` cannot be trusted here: `npm install --install-links` copies
		// `file:` deps, so a rig can hold two copies of the SDK's error classes.
		expect(isGone({ status: 404 })).toBe(true);
		expect(isGone({ status: 403 })).toBe(false);
		expect(isGone(new Error("404"))).toBe(false);
		expect(isGone(null)).toBe(false);
		expect(isGone("404")).toBe(false);
	});
});

describe("RineThreadResumer — every skip records the message's id", () => {
	const quietLogger = { debug: vi.fn(), warn: vi.fn() };

	/** An in-memory store that also keeps what it was asked to record. */
	function recordingStore() {
		const inner = new InMemorySetAside();
		const recorded: SetAsideSighting[] = [];
		const store: SetAsideStore = {
			record: async (sighting) => {
				recorded.push(sighting);
				return inner.record(sighting);
			},
			countAttempt: (entry) => inner.countAttempt(entry),
			due: (limit) => inner.due(limit),
			forget: (id) => inner.forget(id),
		};
		return { store, recorded, inner };
	}

	/** A resumer whose thread map, workflow and store are all observable. */
	async function resumerFor(status: string, mapped: boolean) {
		const map = new InMemoryThreadMap();
		if (mapped) await map.set("bob@acme", "c1", "run-x");
		const { store, recorded, inner } = recordingStore();
		const resumer = new RineThreadResumer({
			workflow: {
				getWorkflowRunById: vi.fn(async () => ({ status })),
				createRun: vi.fn(async () => ({ resume: vi.fn(async () => undefined) })),
			},
			threadMap: map,
			setAside: store,
			logger: quietLogger,
		});
		return { resumer, recorded, inner };
	}

	const arms: Array<[ResumeSkipReason, Record<string, unknown>, boolean]> = [
		["no-conversation", { conversation_id: undefined }, true],
		[
			"decrypt-failed",
			{ decrypt_error: "sender key unavailable", plaintext: null },
			true,
		],
		["no-map", {}, false],
		["not-suspended", {}, true],
	];

	it.each(arms)("records the id on the %s skip", async (reason, over, mapped) => {
		const { resumer, recorded, inner } = await resumerFor(
			reason === "not-suspended" ? "success" : "suspended",
			mapped,
		);
		const out = await resumer.handleInbound(makeInbound(over));
		expect(out).toEqual({ resumed: false, reason });
		// 🔴 The id, recorded — the only handle left on a message the stream has
		// already marked delivered.
		expect(recorded).toEqual([{ id: "m1", reason, groupId: null }]);
		// Whether it is ever offered to the retry follows the reason: a message with
		// no conversation cannot acquire one by being re-read.
		expect(await inner.due()).toHaveLength(isPermanentSetAside(reason) ? 0 : 1);
	});

	it("records the id when the resume itself throws", async () => {
		const map = new InMemoryThreadMap();
		await map.set("bob@acme", "c1", "run-x");
		const { store, recorded } = recordingStore();
		const resumer = new RineThreadResumer({
			workflow: {
				getWorkflowRunById: vi.fn(async () => ({ status: "suspended" })),
				createRun: vi.fn(async () => ({
					resume: vi.fn(async () => {
						throw new Error("transient libsql error");
					}),
				})),
			},
			threadMap: map,
			setAside: store,
			logger: quietLogger,
		});
		const out = await resumer.handleInbound(makeInbound());
		expect(out).toEqual({ resumed: false, reason: "failed" });
		expect(recorded).toEqual([{ id: "m1", reason: "failed", groupId: null }]);
	});

	it("records nothing when the run actually resumed", async () => {
		const { resumer, recorded } = await resumerFor("suspended", true);
		const out = await resumer.handleInbound(makeInbound());
		expect(out).toEqual({ resumed: true, runId: "run-x" });
		expect(recorded).toEqual([]);
	});

	it("records an authenticity refusal as permanent, not as a retryable decrypt", async () => {
		const { resumer, recorded, inner } = await resumerFor("suspended", true);
		const out = await resumer.handleInbound(
			makeInbound({
				decrypt_error: "signature invalid",
				plaintext: null,
				verification_status: "invalid",
				group_id: GROUP_ID,
			}),
		);
		// The caller still hears `decrypt-failed` — widening the public outcome
		// union would break an exhaustive switch — and only the store knows better.
		expect(out).toEqual({ resumed: false, reason: "decrypt-failed" });
		expect(recorded).toEqual([
			{ id: "m1", reason: "refused", groupId: GROUP_ID },
		]);
		expect(await inner.due()).toEqual([]);
	});

	it("a store that cannot record does not crash the dispatch", async () => {
		// The record is best-effort: a store fault must not turn a skipped message
		// into a rejected webhook route or a torn-down SSE loop.
		const warn = vi.fn();
		const resumer = new RineThreadResumer({
			workflow: {
				getWorkflowRunById: vi.fn(async () => ({ status: "suspended" })),
				createRun: vi.fn(async () => ({ resume: vi.fn() })),
			},
			threadMap: new InMemoryThreadMap(),
			setAside: {
				record: async () => {
					throw new Error("disk full");
				},
				countAttempt: async (entry) => entry,
				due: async () => [],
				forget: async () => undefined,
			},
			logger: { debug: vi.fn(), warn },
		});
		await expect(resumer.handleInbound(makeInbound())).resolves.toEqual({
			resumed: false,
			reason: "no-map",
		});
		// And it says so: this is the one failure on the path that really does lose
		// a message, because the stream already consumed it.
		expect(warn).toHaveBeenCalled();
		expect(String(warn.mock.calls[0]?.[0])).toContain("will not be retried");
	});

	it("defaults to an in-memory store so the retry is on without wiring", async () => {
		const resumer = new RineThreadResumer({
			workflow: {
				getWorkflowRunById: vi.fn(async () => ({ status: "suspended" })),
				createRun: vi.fn(async () => ({ resume: vi.fn() })),
			},
			threadMap: new InMemoryThreadMap(),
			logger: quietLogger,
		});
		await resumer.handleInbound(makeInbound());
		expect(await resumer.setAside.due()).toMatchObject([
			{ id: "m1", reason: "no-map" },
		]);
	});
});
