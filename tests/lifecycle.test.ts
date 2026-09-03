/**
 * The outbound lifecycle bridge `rineLifecycle`, driven through the
 * callbacks a host app spreads into `agent.stream/.generate` against the real SDK
 * + real crypto + a mock HTTP boundary.
 *
 * Covers: a fired event attempts EXACTLY ONE best-effort `client.send` (asserted
 * via wire-body decrypt — real HPKE); a send failure is swallowed and never
 * propagates out of the callback; laziness (no client until a callback fires);
 * and the selector→callback map (finish/error/step).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rineLifecycle } from "../src/lifecycle.js";
import {
	API_URL,
	type Harness,
	PEER_AGENT_ID,
	SELF_AGENT_ID,
	SELF_AGENT_NAME,
	makeHarness,
	routeNoGroupOfThatId,
} from "./harness.js";

let h: Harness;

const MSG_UUID = "33333333-3333-4333-8333-333333333333";
const CONV_UUID = "44444444-4444-4444-8444-444444444444";

/** A schema-valid `POST /messages` ack the mock server echoes back. */
function sentAck() {
	return {
		id: MSG_UUID,
		conversation_id: CONV_UUID,
		from_agent_id: SELF_AGENT_ID,
		to_agent_id: PEER_AGENT_ID,
		type: "rine.v1.text",
		encrypted_payload: "OPAQUE_SERVER_ECHO",
		encryption_version: "hpke-v1",
		created_at: "2026-06-11T00:00:00.000Z",
	};
}

beforeEach(() => {
	h = makeHarness();
	// The lifecycle's best-effort send addresses `PEER_AGENT_ID`, an agent. Since
	// A UUID recipient is probed against the group namespace first, so the
	// fixture has to say this id names no group — otherwise the send never
	// reaches `POST /messages` and the assertion reads as a lifecycle defect.
	routeNoGroupOfThatId(h, PEER_AGENT_ID);
});
afterEach(() => {
	h.cleanup();
});

/** Common opts pointing the bridge at the harness identity + the peer recipient. */
function bridgeOpts(on?: Parameters<typeof rineLifecycle>[0]["on"]) {
	return {
		to: PEER_AGENT_ID,
		on,
		configDir: h.configDir,
		apiUrl: API_URL,
		agent: SELF_AGENT_NAME,
	};
}

/**
 * The lifecycle callbacks are fire-and-forget (`void notify(...)`), so the send
 * settles AFTER the synchronous callback returns. Poll the recorded requests for
 * the `POST /messages` the notify makes, up to a short deadline, then return its
 * envelope body. Fails loudly if no (or more than one) POST landed.
 */
async function waitForSend(): Promise<{ encrypted_payload: string }> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		const posts = h.requests.filter(
			(r) => r.method === "POST" && r.path === "/messages",
		);
		if (posts.length > 0) {
			expect(posts).toHaveLength(1);
			return posts[0]?.body as { encrypted_payload: string };
		}
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("no POST /messages was made within the deadline");
}

describe("rineLifecycle — exactly one best-effort send, wire-body decrypts", () => {
	it("onFinish fires ONE send carrying the summarized final text", async () => {
		h.route("POST", /^\/messages$/, () => ({
			json: sentAck(),
		}));

		const cb = rineLifecycle(bridgeOpts(["finish"]));
		// Only the selected callback is installed.
		expect(typeof cb.onFinish).toBe("function");
		expect(cb.onError).toBeUndefined();
		expect(cb.onStepFinish).toBeUndefined();

		cb.onFinish?.({ text: "all done", finishReason: "stop" });

		// Exactly one POST, and decrypting it as the peer yields the summary.
		const env = await waitForSend();
		const plaintext = await h.peerDecrypt(env.encrypted_payload);
		expect(JSON.parse(plaintext)).toEqual({ text: "agent finished: all done" });
	});

	it("onError fires ONE send carrying the error message", async () => {
		h.route("POST", /^\/messages$/, () => ({
			json: sentAck(),
		}));

		const cb = rineLifecycle(bridgeOpts(["error"]));
		cb.onError?.({ error: new Error("model exploded") });

		const env = await waitForSend();
		const plaintext = await h.peerDecrypt(env.encrypted_payload);
		expect(JSON.parse(plaintext)).toEqual({
			text: "agent error: model exploded",
		});
	});

	it("onStepFinish fires ONE send naming the first tool call", async () => {
		h.route("POST", /^\/messages$/, () => ({
			json: sentAck(),
		}));

		const cb = rineLifecycle(bridgeOpts(["step"]));
		cb.onStepFinish?.({ toolCalls: [{ toolName: "rine_send" }] });

		const env = await waitForSend();
		const plaintext = await h.peerDecrypt(env.encrypted_payload);
		expect(JSON.parse(plaintext)).toEqual({ text: "step: rine_send" });
	});

	it("truncates a long final text to the 500-char ceiling", async () => {
		h.route("POST", /^\/messages$/, () => ({
			json: sentAck(),
		}));

		const cb = rineLifecycle(bridgeOpts(["finish"]));
		cb.onFinish?.({ text: "x".repeat(2000) });

		const env = await waitForSend();
		const plaintext = await h.peerDecrypt(env.encrypted_payload);
		const body = JSON.parse(plaintext) as { text: string };
		// The WHOLE summary ("agent finished: " + 2000 x's) is truncated to the
		// 500-char ceiling, then an ellipsis is appended → 501 chars total.
		expect(body.text.startsWith("agent finished: ")).toBe(true);
		expect(body.text.endsWith("…")).toBe(true);
		expect(body.text).toHaveLength(501);
	});
});

describe("rineLifecycle — a send failure is swallowed, never propagates", () => {
	it("a 500 from the wire does not throw out of the callback", async () => {
		h.route("POST", /^\/messages$/, () => ({
			status: 500,
			json: { detail: "boom" },
		}));
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

		const cb = rineLifecycle(bridgeOpts(["finish"]));
		// The callback returns void synchronously; the inner notify must not reject.
		expect(() => cb.onFinish?.({ text: "done" })).not.toThrow();

		// The failure is swallowed + debug-logged (async), never thrown.
		const deadline = Date.now() + 2000;
		while (debug.mock.calls.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(debug).toHaveBeenCalled();
		expect(debug.mock.calls[0]?.[0]).toContain("lifecycle notify failed");
		debug.mockRestore();
	});
});

describe("rineLifecycle — lazy client + opt-in default", () => {
	it("constructs no client and makes no request until a callback fires", () => {
		const before = h.requests.length;
		rineLifecycle(bridgeOpts(["finish", "error"]));
		// Building the factory alone touched the wire zero times.
		expect(h.requests.length).toBe(before);
	});

	it("defaults to firing on finish + error only (not step)", () => {
		const cb = rineLifecycle(bridgeOpts());
		expect(typeof cb.onFinish).toBe("function");
		expect(typeof cb.onError).toBe("function");
		expect(cb.onStepFinish).toBeUndefined();
	});
});
