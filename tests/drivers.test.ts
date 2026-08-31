/**
 * Tier-3 wake drivers (`PollDriver`, `makeWebhookHandler`) — the thin glue that
 * feeds inbound rine messages into a `RineThreadResumer`.
 *
 * Two things the gate must police but did not before:
 *   - Laziness at construction: building a `PollDriver` / a webhook handler must NOT
 *     build an `AsyncRineClient` or start an SSE loop (the client is lazy in
 *     `start()` / the factory builds nothing until called). We spy on
 *     `getRineClient` + `defineAgent` and assert zero calls pre-`start()`.
 *   - the webhook handler dispatches to `handleInbound` and maps the outcome to
 *     `{ resumed }`, without rejecting.
 */

import * as sdk from "@rine-network/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "../src/client.js";
import { PollDriver, makeWebhookHandler } from "../src/drivers.js";
import type { ResumeOutcome, RineThreadResumer } from "../src/inbound.js";

/** A fake resumer recording the messages it was handed, returning a fixed outcome. */
function fakeResumer(outcome: ResumeOutcome) {
	const seen: unknown[] = [];
	const handleInbound = vi.fn(async (msg: unknown) => {
		seen.push(msg);
		return outcome;
	});
	return { resumer: { handleInbound } as unknown as RineThreadResumer, seen };
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
});
