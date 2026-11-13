/**
 * A `PollDriver` loop across a suspend and its lift, on the real SDK stream.
 *
 * The server ends an open stream with no frame when the agent is suspended, then refuses every
 * reconnect with 403 until the agent is resumed. A client that treats the clean end as the end
 * leaves `defineAgent`'s loop returning without an error: a driver that is deaf for good. Only
 * the HTTP layer is stubbed here; `AsyncRineClient`, its stream reconnect loop and `defineAgent`
 * are the shipped ones.
 */

import { randomUUID } from "node:crypto";
import { AsyncRineClient } from "@rine-network/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "../src/client.js";
import { PollDriver } from "../src/drivers.js";
import type { RineThreadResumer } from "../src/inbound.js";
import { InMemorySetAside } from "../src/setaside.js";

const AGENT = randomUUID();
const quietLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

function frame(id: string): string {
	const envelope = {
		id,
		conversation_id: randomUUID(),
		from_agent_id: randomUUID(),
		to_agent_id: AGENT,
		type: "rine.v1.task_request",
		encrypted_payload: "sealed",
		encryption_version: "hpke-hybrid-v2",
		created_at: "2026-11-06T09:00:00.000Z",
	};
	return `event: message\ndata: ${JSON.stringify(envelope)}\nid: ${id}\n\n`;
}

/** An SSE body that sends `text` and closes cleanly (`hold: false`) or stays open until aborted. */
function sse(text: string, signal: AbortSignal, hold = false): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			if (hold) signal.addEventListener("abort", () => controller.error(signal.reason));
			else controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const held = () =>
	new Response(JSON.stringify({ error: "agent_suspended", detail: "agent suspended" }), {
		status: 403,
	});

describe("PollDriver across a suspend and its lift", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("test_poll_driver_when_the_stream_is_closed_at_a_suspend_then_it_wakes_the_run_after_the_lift", async () => {
		vi.useFakeTimers();
		const [first, second] = [randomUUID(), randomUUID()];
		const client = new AsyncRineClient({});
		const opened: (string | undefined)[] = [];
		const script = [
			(s: AbortSignal) => sse(frame(first), s),
			() => held(),
			() => held(),
			(s: AbortSignal) => sse(frame(second), s, true),
		];
		// biome-ignore lint/suspicious/noExplicitAny: stubbing the SDK's HTTP layer
		const internals = client as any;
		internals.http.openStream = async (
			_path: string,
			opts: { headers?: Record<string, string>; signal: AbortSignal },
		) => {
			opened.push(opts.headers?.["Last-Event-ID"]);
			const next = script[opened.length - 1];
			return next ? next(opts.signal) : new Promise<Response>(() => undefined);
		};
		internals.messagingResource.resolveSenderId = async () => AGENT;
		internals.http.getCoreHttpClient = () => ({ markDelivered: vi.fn(async () => ({ marked: 1 })) });
		vi.spyOn(clientModule, "getRineClient").mockReturnValue(client as never);

		const handled: string[] = [];
		const resumer = {
			handleInbound: vi.fn(async (msg: { id: string }) => {
				handled.push(msg.id);
				return { resumed: true, runId: "r1" };
			}),
			setAside: new InMemorySetAside(),
		} as unknown as RineThreadResumer;
		const driver = new PollDriver({ resumer, logger: quietLogger });
		await driver.start();

		// the 1 s pause after the clean end, then the 403 backoff of 2 s and 4 s
		await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 100);

		expect(handled).toEqual([first, second]);
		expect(opened).toEqual([undefined, first, first, first]);
		await driver.stop();
	});
});
