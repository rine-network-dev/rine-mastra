/**
 * The bounded retry: what one sweep actually does with a parked message, and
 * when it runs.
 *
 * The load-bearing assertion in this file is the ORDER — group sync, then a
 * re-read by id, then the ordinary resume path. A retry that re-reads without
 * syncing can only heal a sealed group message by luck, and a retry that
 * consumes the row it re-reads destroys the message it was sent to rescue.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SETASIDE_MAX_ATTEMPTS,
	SETASIDE_SWEEP_BATCH,
	SETASIDE_SWEEP_INTERVAL_MS,
} from "../src/constants.js";
import type { RineThreadResumer } from "../src/inbound.js";
import { startSweepSchedule } from "../src/setaside-schedule.js";
import { sweepSetAside } from "../src/setaside-sweep.js";
import type { RetryClient, SweepArgs } from "../src/setaside-sweep.js";
import { InMemorySetAside } from "../src/setaside.js";
import type { SetAsideStore } from "../src/setaside.js";
import { makeInbound } from "./harness.js";

const MSG = "11111111-1111-4111-8111-111111111111";
const MSG_B = "22222222-2222-4222-8222-222222222222";
const GROUP = "44444444-4444-4444-8444-444444444444";

/** One sweep's worth of test double: a store, a client and a resumer. */
function rig(
	opts: {
		read?: (id: string, o?: { peek?: boolean }) => Promise<unknown>;
		sync?: (group: string) => Promise<unknown>;
		resumed?: boolean;
		store?: SetAsideStore;
	} = {},
) {
	// One log of every call, in order: this is the only way to assert that the
	// sync happened BEFORE the read rather than merely also happening.
	const calls: string[] = [];
	const setAside = opts.store ?? new InMemorySetAside();
	const client = {
		groups: {
			sync: async (group: string) => {
				calls.push(`sync:${group}`);
				return opts.sync ? opts.sync(group) : undefined;
			},
		},
		read: async (id: string, o?: { peek?: boolean }) => {
			calls.push(`read:${id}:peek=${o?.peek}`);
			return opts.read ? opts.read(id, o) : makeInbound({ id });
		},
	} as unknown as RetryClient;
	const handleInbound = vi.fn(async (msg: { id: string }) => {
		calls.push(`handle:${msg.id}`);
		return opts.resumed === false
			? ({ resumed: false, reason: "no-map" } as const)
			: ({ resumed: true, runId: "run-x" } as const);
	});
	const resumer = { setAside, handleInbound } as unknown as RineThreadResumer;
	const logger = { debug: vi.fn(), warn: vi.fn() };
	const args: SweepArgs = { client, resumer, logger };
	return { args, calls, setAside, handleInbound, logger };
}

describe("sweepSetAside — one pass over the parked messages", () => {
	it("syncs the group, THEN re-reads the message by id, THEN resumes", async () => {
		const r = rig();
		await r.setAside.record({
			id: MSG,
			reason: "decrypt-failed",
			groupId: GROUP,
		});
		await sweepSetAside(r.args);
		// 🔴 The whole fix in one assertion. The re-read is what recovers a row the
		// stream already marked delivered; the sync in front of it is what makes the
		// re-read able to open a message sealed under a key that arrived late.
		expect(r.calls).toEqual([
			`sync:${GROUP}`,
			`read:${MSG}:peek=true`,
			`handle:${MSG}`,
		]);
	});

	it("peeks on the re-read, so a row still `new` is not consumed by its own rescue", async () => {
		// The webhook driver is the case: there the row may not have been marked
		// yet, and a retry that consumed it would leave the second failure with
		// nothing to try.
		const r = rig();
		await r.setAside.record({ id: MSG, reason: "no-map", groupId: null });
		await sweepSetAside(r.args);
		expect(r.calls).toEqual([`read:${MSG}:peek=true`, `handle:${MSG}`]);
	});

	it("forgets a message whose retry resumed a run", async () => {
		const r = rig();
		await r.setAside.record({ id: MSG, reason: "no-map", groupId: null });
		await sweepSetAside(r.args);
		expect(await r.setAside.due()).toEqual([]);
	});

	it("counts an attempt, and keeps the entry, when the retry still cannot resume", async () => {
		const r = rig({ resumed: false });
		await r.setAside.record({ id: MSG, reason: "no-map", groupId: null });
		await sweepSetAside(r.args);
		expect(await r.setAside.due()).toMatchObject([{ id: MSG, attempts: 1 }]);
	});

	it("does not sync for a reason a sync cannot heal", async () => {
		// A message that never reached the ciphertext has nothing about its group to
		// catch up on; syncing anyway would be a round trip per parked message on
		// every sweep, spent on nothing.
		const r = rig();
		await r.setAside.record({ id: MSG, reason: "no-map", groupId: GROUP });
		await sweepSetAside(r.args);
		expect(r.calls.some((c) => c.startsWith("sync:"))).toBe(false);
	});

	it("does not sync for a 1:1 message", async () => {
		const r = rig();
		await r.setAside.record({ id: MSG, reason: "decrypt-failed", groupId: null });
		await sweepSetAside(r.args);
		expect(r.calls).toEqual([`read:${MSG}:peek=true`, `handle:${MSG}`]);
	});

	it("syncs once per group per sweep, however many of its messages are parked", async () => {
		const r = rig({ resumed: false });
		await r.setAside.record({
			id: MSG,
			reason: "decrypt-failed",
			groupId: GROUP,
		});
		await r.setAside.record({
			id: MSG_B,
			reason: "decrypt-failed",
			groupId: GROUP,
		});
		await sweepSetAside(r.args);
		// One absent sender key seals every message sent under it, so a batch of
		// fifty entries on one group is the ordinary shape of this store.
		expect(r.calls.filter((c) => c.startsWith("sync:"))).toEqual([
			`sync:${GROUP}`,
		]);
		expect(r.calls.filter((c) => c.startsWith("read:"))).toHaveLength(2);
	});

	it("reads anyway when the sync fails, so a failed sync costs no attempt", async () => {
		// The bound counts retries of the READ. A server down for five minutes must
		// not exhaust a message's five chances without ever having tried one.
		const r = rig({
			sync: async () => {
				throw new Error("502 bad gateway");
			},
			resumed: false,
		});
		await r.setAside.record({
			id: MSG,
			reason: "decrypt-failed",
			groupId: GROUP,
		});
		await sweepSetAside(r.args);
		expect(r.calls).toEqual([
			`sync:${GROUP}`,
			`read:${MSG}:peek=true`,
			`handle:${MSG}`,
		]);
		expect(r.logger.warn).toHaveBeenCalled();
	});

	it("never lets a server-supplied group id reach a URL unvalidated", async () => {
		// The id came off a row the server sent. A traversal-shaped one must not be
		// interpolated into a path, and the message's own retry must still run.
		const r = rig();
		await r.setAside.record({
			id: MSG,
			reason: "decrypt-failed",
			groupId: "../agents/victim",
		});
		await sweepSetAside(r.args);
		expect(r.calls).toEqual([`read:${MSG}:peek=true`, `handle:${MSG}`]);
		// Nothing was even ATTEMPTED. This is what distinguishes the local guard
		// from leaning on the SDK brand's own TypeError: that throw lands in the
		// sync's catch, which then WARNS about a group nobody should have asked
		// about — once per sweep, for as long as the row stays parked.
		expect(r.logger.warn).not.toHaveBeenCalled();
	});

	it("forgets a row whose id is not a message id, instead of retrying it five times", async () => {
		const r = rig();
		await r.setAside.record({ id: "../messages/x", reason: "no-map", groupId: null });
		await sweepSetAside(r.args);
		expect(r.calls).toEqual([]);
		expect(await r.setAside.due()).toEqual([]);
		expect(String(r.logger.warn.mock.calls[0]?.[0])).toContain(
			"not a rine message id",
		);
	});

	it("forgets a message the server no longer has", async () => {
		const r = rig({
			read: async () => {
				throw { status: 404, message: "not found" };
			},
		});
		await r.setAside.record({ id: MSG, reason: "no-map", groupId: null });
		await sweepSetAside(r.args);
		// Nothing to retry, so the row is not kept to be re-asked four more times.
		expect(await r.setAside.due()).toEqual([]);
	});

	it("counts an attempt when the re-read fails for any other reason", async () => {
		const r = rig({
			read: async () => {
				throw { status: 503, message: "unavailable" };
			},
		});
		await r.setAside.record({ id: MSG, reason: "no-map", groupId: null });
		await sweepSetAside(r.args);
		expect(await r.setAside.due()).toMatchObject([{ id: MSG, attempts: 1 }]);
	});

	it("says once, at the bound, that a message is no longer retried — and how to read it", async () => {
		const r = rig({ resumed: false });
		await r.setAside.record({ id: MSG, reason: "no-map", groupId: null });
		for (let i = 0; i < SETASIDE_MAX_ATTEMPTS; i += 1) {
			await sweepSetAside(r.args);
		}
		const warnings = r.logger.warn.mock.calls.map((c) => String(c[0]));
		const giveUp = warnings.filter((w) => w.includes("no longer retried"));
		expect(giveUp).toHaveLength(1);
		expect(giveUp[0]).toContain(MSG);
		// 🔴 The sentence says what is still true — the id is readable — and NOT
		// that the message is still in the inbox listing, which on the SSE driver it
		// is not. That claim is the one this whole store exists to stop repeating.
		expect(giveUp[0]).toContain(`client.read("${MSG}")`);
		expect(giveUp[0]).not.toContain("inbox");
	});

	it("asks for at most one batch, and does nothing at all when nothing is parked", async () => {
		const due = vi.fn(async () => []);
		const r = rig({
			store: {
				record: async () => {
					throw new Error("unused");
				},
				countAttempt: async (e) => e,
				due,
				forget: async () => undefined,
			},
		});
		await sweepSetAside(r.args);
		expect(due).toHaveBeenCalledWith(SETASIDE_SWEEP_BATCH);
		expect(r.calls).toEqual([]);
		expect(r.logger.debug).not.toHaveBeenCalled();
	});
});

describe("startSweepSchedule — when the retry runs", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A store whose `due` calls are the count of sweeps that actually ran. */
	function countingStore() {
		const due = vi.fn(async () => []);
		return {
			due,
			store: {
				record: async () => {
					throw new Error("unused");
				},
				countAttempt: async (e) => e,
				due,
				forget: async () => undefined,
			} as SetAsideStore,
		};
	}

	it("sweeps on the first call after a restart, then gates the cadence", async () => {
		vi.useFakeTimers();
		const { due, store } = countingStore();
		const r = rig({ store });
		const sweep = startSweepSchedule(r.args);
		await sweep();
		await sweep();
		await sweep();
		// The first message after a restart retries what the previous process parked
		// rather than waiting out an interval it never served; the ones behind it do
		// not re-sweep a store that was just swept.
		expect(due).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(SETASIDE_SWEEP_INTERVAL_MS);
		await sweep();
		expect(due).toHaveBeenCalledTimes(2);
	});

	it("runs on a timer while a signal bounds it, and stops when it aborts", async () => {
		vi.useFakeTimers();
		const { due, store } = countingStore();
		const r = rig({ store });
		const lifetime = new AbortController();
		startSweepSchedule({ ...r.args, signal: lifetime.signal });
		await vi.advanceTimersByTimeAsync(SETASIDE_SWEEP_INTERVAL_MS);
		// A quiet channel still retries: without this a host that received nothing
		// for six hours would retry nothing for six hours.
		expect(due).toHaveBeenCalledTimes(1);
		lifetime.abort();
		await vi.advanceTimersByTimeAsync(SETASIDE_SWEEP_INTERVAL_MS * 3);
		expect(due).toHaveBeenCalledTimes(1);
	});

	it("installs no timer without a signal", async () => {
		vi.useFakeTimers();
		const { due, store } = countingStore();
		const r = rig({ store });
		startSweepSchedule(r.args);
		await vi.advanceTimersByTimeAsync(SETASIDE_SWEEP_INTERVAL_MS * 3);
		// The webhook driver has no lifetime to hang a timer on, so it gets the tail
		// trigger alone rather than a handle nothing closes.
		expect(due).not.toHaveBeenCalled();
	});

	it("installs no timer for a signal that is already aborted", async () => {
		vi.useFakeTimers();
		const { due, store } = countingStore();
		const r = rig({ store });
		startSweepSchedule({ ...r.args, signal: AbortSignal.abort() });
		await vi.advanceTimersByTimeAsync(SETASIDE_SWEEP_INTERVAL_MS * 3);
		expect(due).not.toHaveBeenCalled();
	});

	it("swallows a failing sweep, so a retry never costs the live message", async () => {
		const r = rig({
			store: {
				record: async () => {
					throw new Error("unused");
				},
				countAttempt: async (e) => e,
				due: async () => {
					throw new Error("database is locked");
				},
				forget: async () => undefined,
			},
		});
		const sweep = startSweepSchedule(r.args);
		await expect(sweep()).resolves.toBeUndefined();
		expect(String(r.logger.warn.mock.calls[0]?.[0])).toContain(
			"set-aside sweep failed",
		);
	});
});
