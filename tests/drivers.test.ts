/**
 * Tier-3 wake drivers (`PollDriver`, `makeWebhookHandler`) — the thin glue that
 * feeds inbound rine messages into a `RineThreadResumer`.
 *
 * Three things the gate must police but did not before:
 *   - Laziness at construction: building a `PollDriver` / a webhook handler must NOT
 *     build an `AsyncRineClient` or start an SSE loop (the client is lazy in
 *     `start()` / the factory builds nothing until called). We spy on
 *     `getRineClient` + `defineAgent` and assert zero calls pre-`start()`.
 *   - the webhook handler dispatches to `handleInbound` and maps the outcome to
 *     `{ resumed }`, without rejecting.
 *   - each driver actually RUNS the resumer's bounded retry, and runs it behind
 *     the live message rather than in front of it. A driver that records parked
 *     messages and never retries them is the defect this apparatus was built for,
 *     wearing a green suite.
 */

import * as sdk from "@rine-network/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "../src/client.js";
import { SETASIDE_SWEEP_INTERVAL_MS } from "../src/constants.js";
import { PollDriver, makeWebhookHandler } from "../src/drivers.js";
import type { ResumeOutcome, RineThreadResumer } from "../src/inbound.js";
import { InMemorySetAside } from "../src/setaside.js";

/** A message id the SDK's UUID brand accepts, for the entry the sweep retries. */
const PARKED = "11111111-1111-4111-8111-111111111111";

/**
 * A fake resumer recording the messages it was handed, returning a fixed outcome.
 *
 * It carries a REAL set-aside store: the drivers reach through the resumer for it
 * (`resumer.setAside`), so a fake without one turns every sweep into a swallowed
 * TypeError — a retry that silently never runs, with the suite still green.
 */
function fakeResumer(outcome: ResumeOutcome) {
	const seen: unknown[] = [];
	const setAside = new InMemorySetAside();
	const handleInbound = vi.fn(async (msg: unknown) => {
		seen.push(msg);
		return outcome;
	});
	return {
		resumer: { handleInbound, setAside } as unknown as RineThreadResumer,
		seen,
		setAside,
	};
}

const quietLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PollDriver — builds nothing at construction", () => {
	it("constructing a PollDriver builds no client and no SSE loop", () => {
		const clientSpy = vi.spyOn(clientModule, "getRineClient");
		const agentSpy = vi.spyOn(sdk, "defineAgent");
		const { resumer } = fakeResumer({ resumed: true, runId: "r1" });

		// eslint-disable-next-line no-new -- the side-effect under test is construction
		new PollDriver({
			resumer,
			configDir: "/tmp/cfg",
			apiUrl: "https://x",
			logger: quietLogger,
		});

		// Lazy by construction: nothing networked, no actor defined.
		expect(clientSpy).toHaveBeenCalledTimes(0);
		expect(agentSpy).toHaveBeenCalledTimes(0);
	});
});

describe("makeWebhookHandler", () => {
	it("the factory builds nothing until the handler is called", () => {
		const clientSpy = vi.spyOn(clientModule, "getRineClient");
		const agentSpy = vi.spyOn(sdk, "defineAgent");
		const { resumer } = fakeResumer({ resumed: false, reason: "no-map" });

		makeWebhookHandler({ resumer, logger: quietLogger });

		expect(clientSpy).toHaveBeenCalledTimes(0);
		expect(agentSpy).toHaveBeenCalledTimes(0);
	});

	it("dispatches a message to handleInbound and maps a resume to { resumed: true }", async () => {
		const { resumer, seen } = fakeResumer({ resumed: true, runId: "r1" });
		const handle = makeWebhookHandler({ resumer, logger: quietLogger });

		// biome-ignore lint/suspicious/noExplicitAny: synthetic inbound fixture
		const msg = { id: "m1" } as any;
		const out = await handle(msg);

		expect(out).toEqual({ resumed: true });
		expect(seen).toEqual([msg]);
	});

	it("maps a skip outcome to { resumed: false } and never rejects", async () => {
		const { resumer } = fakeResumer({ resumed: false, reason: "failed" });
		const handle = makeWebhookHandler({ resumer, logger: quietLogger });

		// biome-ignore lint/suspicious/noExplicitAny: synthetic inbound fixture
		await expect(handle({ id: "m2" } as any)).resolves.toEqual({
			resumed: false,
		});
	});

	it("retries a parked message at the TAIL of a delivery", async () => {
		const { resumer, setAside, seen } = fakeResumer({
			resumed: true,
			runId: "r1",
		});
		await setAside.record({ id: PARKED, reason: "no-map", groupId: null });
		const client = fakeRetryClient();
		vi.spyOn(clientModule, "getRineClient").mockReturnValue(client.client);
		const handle = makeWebhookHandler({ resumer, logger: quietLogger });

		// biome-ignore lint/suspicious/noExplicitAny: synthetic inbound fixture
		await handle({ id: "live" } as any);

		// The live message first, the parked one behind it — a retry must never be
		// what an HTTP route is waiting on before it answers about this delivery.
		expect(client.reads).toEqual([PARKED]);
		expect((seen[0] as { id: string }).id).toBe("live");
		expect(await setAside.due()).toEqual([]);
	});

	it("answers the delivery even when the retry's client cannot be built", async () => {
		// Building the client is the one step of the retry outside the sweep's own
		// catch. A host with an unreadable config dir must still get its answer for
		// a message that was already resumed.
		const { resumer, setAside } = fakeResumer({ resumed: true, runId: "r1" });
		await setAside.record({ id: PARKED, reason: "no-map", groupId: null });
		vi.spyOn(clientModule, "getRineClient").mockImplementation(() => {
			throw new Error("EACCES: /root/.config/rine");
		});
		const warn = vi.fn();
		const handle = makeWebhookHandler({
			resumer,
			logger: { ...quietLogger, warn },
		});

		// biome-ignore lint/suspicious/noExplicitAny: synthetic inbound fixture
		await expect(handle({ id: "live" } as any)).resolves.toEqual({
			resumed: true,
		});
		expect(String(warn.mock.calls[0]?.[0])).toContain("could not run");
	});
});

/** A client narrow enough for the retry path, logging the ids it was asked for. */
function fakeRetryClient() {
	const reads: string[] = [];
	const client = {
		groups: { sync: vi.fn(async () => undefined) },
		read: vi.fn(async (id: string) => {
			reads.push(id);
			return { id, conversation_id: "c1", sender_handle: "bob@acme" };
		}),
		// biome-ignore lint/suspicious/noExplicitAny: narrowed test double
	} as any;
	return { client, reads };
}

describe("PollDriver — the retry rides the SSE loop", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Start a driver with `defineAgent` stubbed, handing back its `onMessage`. */
	async function startWithStubbedAgent(driverSetAside: InMemorySetAside) {
		const { resumer, seen } = fakeResumer({ resumed: true, runId: "r1" });
		// biome-ignore lint/suspicious/noExplicitAny: the fake resumer owns the store
		(resumer as any).setAside = driverSetAside;
		const client = fakeRetryClient();
		vi.spyOn(clientModule, "getRineClient").mockReturnValue(client.client);
		let onMessage: ((msg: unknown) => Promise<void>) | undefined;
		vi.spyOn(sdk, "defineAgent").mockImplementation((opts) => {
			onMessage = opts.onMessage as (msg: unknown) => Promise<void>;
			// biome-ignore lint/suspicious/noExplicitAny: stubbed SDK actor
			return { start: async () => undefined, stop: async () => undefined } as any;
		});
		const driver = new PollDriver({ resumer, logger: quietLogger });
		await driver.start();
		return { driver, onMessage, client, seen };
	}

	it("sweeps after handing over a live message, never before it", async () => {
		const setAside = new InMemorySetAside();
		await setAside.record({ id: PARKED, reason: "no-map", groupId: null });
		const { onMessage, client, seen } = await startWithStubbedAgent(setAside);

		await onMessage?.({ id: "live", conversation_id: "c1" });

		expect((seen[0] as { id: string }).id).toBe("live");
		expect(client.reads).toEqual([PARKED]);
	});

	it("sweeps on the interval, and stops when the driver does", async () => {
		vi.useFakeTimers();
		const setAside = new InMemorySetAside();
		const { driver, client } = await startWithStubbedAgent(setAside);

		await setAside.record({ id: PARKED, reason: "no-map", groupId: null });
		await vi.advanceTimersByTimeAsync(SETASIDE_SWEEP_INTERVAL_MS);
		// A quiet stream still retries — the half a push transport cannot supply.
		expect(client.reads).toEqual([PARKED]);

		await setAside.record({ id: PARKED, reason: "no-map", groupId: null });
		await driver.stop();
		await vi.advanceTimersByTimeAsync(SETASIDE_SWEEP_INTERVAL_MS * 3);
		// A stopped driver holds no timer: it must not keep reading a config dir the
		// host has moved on from.
		expect(client.reads).toEqual([PARKED]);
	});
});
