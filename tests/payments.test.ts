/**
 * The 2 x402 payment tools (`rine_pay`, `rine_fulfill`) driven through their
 * public Mastra `execute` interface against the REAL ts-sdk `client.payments`
 * facade + REAL crypto (HPKE seal/open, EIP-3009 signing, on-disk wallet +
 * spend policy + journal) and a mock HTTP boundary (the harness `fetch`, which
 * also fronts the facilitator's `/verify` + `/settle`).
 *
 * Covers: payer typed-status vocabulary (submitted / not-payment-required /
 * no-wallet / policy-refused / above-auto-pay-threshold / already-paid), the
 * marker default-ON with opt-out, permanent-debit accounting, and the payee
 * fulfill outcomes (settled with verbatim network slug / verification-failed
 * skips settle / settlement-failed / facilitator-error / not-payment /
 * no-facilitator).
 */

import {
	createWallet,
	getWalletAddress,
	readDailySpent,
	savePolicy,
} from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRineFulfillTool, createRinePayTool } from "../src/payments.js";
import {
	API_URL,
	type Harness,
	PEER_AGENT_ID,
	SELF_AGENT_ID,
	makeHarness,
	runTool,
} from "./harness.js";

let h: Harness;

const QUOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONV_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REPLY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const EURC_BASE = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";

const HAPPY_POLICY = {
	perTxCap: "1.00",
	dailyCap: "10.00",
	allowedAssets: ["EURC"],
	allowedNetworks: ["eip155:8453"],
	autoPayThreshold: "1.00",
};

/** A verbatim x402 `PaymentRequired` quote object (0.10 EURC on Base). */
function paymentRequired(amount = "100000") {
	return {
		x402Version: 2,
		resource: {
			url: "rine:task",
			description: "translate",
			mimeType: "application/json",
		},
		accepts: [
			{
				scheme: "exact",
				network: "eip155:8453",
				amount,
				asset: EURC_BASE,
				payTo: "0x000000000000000000000000000000000000dEaD",
				maxTimeoutSeconds: 60,
				extra: { name: "EURC", version: "2" },
			},
		],
		extensions: {},
	};
}

/** A signed x402 `PaymentPayload` (the payee receives this to fulfill). */
function paymentPayload() {
	return {
		x402Version: 2,
		accepted: paymentRequired().accepts[0],
		payload: {
			signature: `0x${"11".repeat(65)}`,
			authorization: {
				from: "0x1111111111111111111111111111111111111111",
				to: "0x000000000000000000000000000000000000dEaD",
				value: "100000",
				validAfter: "1",
				validBefore: "9999999999",
				nonce: `0x${"22".repeat(32)}`,
			},
		},
		extensions: {},
	};
}

/** Register `GET /messages/{id}` to return a self-decryptable x402 envelope. */
async function routeIncoming(
	id: string,
	type: string,
	payload: unknown,
): Promise<void> {
	const env = await h.selfEncrypt(payload);
	h.route("GET", new RegExp(`^/messages/${id}$`), () => ({
		json: {
			id,
			conversation_id: CONV_ID,
			from_agent_id: PEER_AGENT_ID,
			to_agent_id: SELF_AGENT_ID,
			type,
			encrypted_payload: env.encrypted_payload,
			encryption_version: env.encryption_version,
			sender_signing_kid: env.sender_signing_kid,
			content_type: "application/json",
			created_at: "2026-07-17T00:00:00.000Z",
		},
	}));
}

/** Capture the in-thread reply the tool posts (the payment / receipt). */
function routeReply(id: string): { body: () => Record<string, unknown> } {
	let captured: Record<string, unknown> = {};
	h.route("POST", new RegExp(`^/messages/${id}/reply$`), (req) => {
		captured = req.body as Record<string, unknown>;
		return {
			json: {
				id: REPLY_ID,
				conversation_id: CONV_ID,
				from_agent_id: SELF_AGENT_ID,
				to_agent_id: PEER_AGENT_ID,
				type: (req.body as Record<string, unknown>).type,
				encrypted_payload: "OPAQUE",
				encryption_version: "hpke-v1",
				created_at: "2026-07-17T00:00:00.000Z",
			},
		};
	});
	return { body: () => captured };
}

function markerStatus(body: Record<string, unknown> | undefined): string {
	const md = (body?.metadata ?? {}) as Record<string, { status?: string }>;
	return md["rine.x402"]?.status ?? "";
}

beforeEach(() => {
	h = makeHarness();
});
afterEach(() => {
	h.cleanup();
});

describe("rine_pay (payer typed statuses)", () => {
	function payTool() {
		return createRinePayTool({ configDir: h.configDir, apiUrl: API_URL });
	}

	it("payment-submitted: signs + sends in-thread, records the permanent debit, marker ON", async () => {
		createWallet(h.configDir, SELF_AGENT_ID);
		savePolicy(h.configDir, SELF_AGENT_ID, HAPPY_POLICY);
		await routeIncoming(
			QUOTE_ID,
			"rine.v1.x402_payment_required",
			paymentRequired(),
		);
		const reply = routeReply(QUOTE_ID);

		const out = await runTool(payTool(), { messageId: QUOTE_ID }, h);

		expect(out).toContain("status: payment-submitted");
		expect(out).toContain(REPLY_ID);
		// In-thread reply of the payment type carrying the default-ON marker.
		expect(reply.body().type).toBe("rine.v1.x402_payment");
		expect(markerStatus(reply.body())).toBe("payment-submitted");
		// 0.10 EURC = 100000 canonical micro-units, debited once.
		expect(readDailySpent(h.configDir, SELF_AGENT_ID)).toBe(100000n);
		// The wallet key is NEVER surfaced in the model-facing string.
		expect(out).not.toContain(getWalletAddress(h.configDir, SELF_AGENT_ID));
	});

	it("emitMarker:false sends a fully-sealed payment (no marker)", async () => {
		createWallet(h.configDir, SELF_AGENT_ID);
		savePolicy(h.configDir, SELF_AGENT_ID, HAPPY_POLICY);
		await routeIncoming(
			QUOTE_ID,
			"rine.v1.x402_payment_required",
			paymentRequired(),
		);
		const reply = routeReply(QUOTE_ID);

		await runTool(payTool(), { messageId: QUOTE_ID, emitMarker: false }, h);
		expect(reply.body().metadata).toBeUndefined();
	});

	it("not-payment-required: a non-x402 message is rejected without spending", async () => {
		createWallet(h.configDir, SELF_AGENT_ID);
		savePolicy(h.configDir, SELF_AGENT_ID, HAPPY_POLICY);
		await routeIncoming(QUOTE_ID, "rine.v1.task_request", { text: "hi" });

		const out = await runTool(payTool(), { messageId: QUOTE_ID }, h);
		expect(out).toContain("status: not-payment-required");
		expect(readDailySpent(h.configDir, SELF_AGENT_ID)).toBe(0n);
	});

	it("no-wallet: a valid quote with no wallet returns no-wallet, no debit", async () => {
		savePolicy(h.configDir, SELF_AGENT_ID, HAPPY_POLICY); // policy but NO wallet
		await routeIncoming(
			QUOTE_ID,
			"rine.v1.x402_payment_required",
			paymentRequired(),
		);

		const out = await runTool(payTool(), { messageId: QUOTE_ID }, h);
		expect(out).toContain("status: no-wallet");
		expect(readDailySpent(h.configDir, SELF_AGENT_ID)).toBe(0n);
	});

	it("policy-refused: deny-by-default when no policy is configured", async () => {
		createWallet(h.configDir, SELF_AGENT_ID); // wallet but NO policy
		await routeIncoming(
			QUOTE_ID,
			"rine.v1.x402_payment_required",
			paymentRequired(),
		);

		const out = await runTool(payTool(), { messageId: QUOTE_ID }, h);
		expect(out).toContain("status: policy-refused");
		expect(readDailySpent(h.configDir, SELF_AGENT_ID)).toBe(0n);
	});

	it("above-auto-pay-threshold: autoPay over the threshold refuses without sending", async () => {
		createWallet(h.configDir, SELF_AGENT_ID);
		savePolicy(h.configDir, SELF_AGENT_ID, {
			...HAPPY_POLICY,
			autoPayThreshold: "0.05", // 0.10 quote is over it
		});
		await routeIncoming(
			QUOTE_ID,
			"rine.v1.x402_payment_required",
			paymentRequired(),
		);

		const out = await runTool(
			payTool(),
			{ messageId: QUOTE_ID, autoPay: true },
			h,
		);
		expect(out).toContain("status: above-auto-pay-threshold");
		expect(readDailySpent(h.configDir, SELF_AGENT_ID)).toBe(0n);
	});

	it("already-paid: a second pay of the same quote is refused unless allowRepay", async () => {
		createWallet(h.configDir, SELF_AGENT_ID);
		savePolicy(h.configDir, SELF_AGENT_ID, HAPPY_POLICY);
		await routeIncoming(
			QUOTE_ID,
			"rine.v1.x402_payment_required",
			paymentRequired(),
		);
		routeReply(QUOTE_ID);

		const first = await runTool(payTool(), { messageId: QUOTE_ID }, h);
		expect(first).toContain("status: payment-submitted");

		const second = await runTool(payTool(), { messageId: QUOTE_ID }, h);
		expect(second).toContain("status: already-paid");
		// No second debit.
		expect(readDailySpent(h.configDir, SELF_AGENT_ID)).toBe(100000n);

		// allowRepay forces a deliberate second permanent debit.
		const repay = await runTool(
			payTool(),
			{ messageId: QUOTE_ID, allowRepay: true },
			h,
		);
		expect(repay).toContain("status: payment-submitted");
		expect(readDailySpent(h.configDir, SELF_AGENT_ID)).toBe(200000n);
	});

	it("D2: payments.autoPay config defaults the tool to threshold-gated auto-pay", async () => {
		createWallet(h.configDir, SELF_AGENT_ID);
		savePolicy(h.configDir, SELF_AGENT_ID, {
			...HAPPY_POLICY,
			autoPayThreshold: "0.05",
		});
		await routeIncoming(
			QUOTE_ID,
			"rine.v1.x402_payment_required",
			paymentRequired(),
		);
		routeReply(QUOTE_ID);

		// autoPay comes from config (default OFF everywhere else); here ON.
		const tool = createRinePayTool({
			configDir: h.configDir,
			apiUrl: API_URL,
			autoPay: true,
		});
		const out = await runTool(tool, { messageId: QUOTE_ID }, h);
		expect(out).toContain("status: above-auto-pay-threshold");
	});
});

describe("rine_fulfill (payee)", () => {
	function fulfillTool(facilitator?: string) {
		return createRineFulfillTool({
			configDir: h.configDir,
			apiUrl: API_URL,
			facilitator: facilitator ?? "payai",
		});
	}

	/** Mock the external facilitator `/verify` (+ optional `/settle`). */
	function routeFacilitator(verify: unknown, settle?: unknown): void {
		h.route("POST", /^\/verify$/, () => ({ json: verify }));
		if (settle !== undefined) {
			h.route("POST", /^\/settle$/, () => ({ json: settle }));
		}
	}

	it("settled: verifies + settles, echoes the network slug verbatim, receipt in-thread", async () => {
		await routeIncoming(PAYMENT_ID, "rine.v1.x402_payment", paymentPayload());
		const reply = routeReply(PAYMENT_ID);
		routeFacilitator(
			{ isValid: true, payer: "0x1111" },
			{
				success: true,
				transaction: "0xdeadbeef",
				network: "base-sepolia", // v1 slug — must be echoed verbatim
				payer: "0x1111",
			},
		);

		const out = await runTool(fulfillTool(), { messageId: PAYMENT_ID }, h);

		expect(out).toContain("status: settled —");
		expect(out).toContain("base-sepolia"); // verbatim slug, not CAIP-2
		expect(out).toContain("0xdeadbeef");
		expect(reply.body().type).toBe("rine.v1.x402_receipt");
		expect(markerStatus(reply.body())).toBe("payment-completed");
	});

	it("verification-failed: an invalid authorization skips settle and sends a failure receipt", async () => {
		await routeIncoming(PAYMENT_ID, "rine.v1.x402_payment", paymentPayload());
		const reply = routeReply(PAYMENT_ID);
		routeFacilitator({ isValid: false, invalidReason: "insufficient_funds" });

		const out = await runTool(fulfillTool(), { messageId: PAYMENT_ID }, h);

		expect(out).toContain("status: verification-failed");
		expect(out).toContain("insufficient_funds");
		// Settle was NEVER called.
		expect(h.requests.some((r) => r.path === "/settle")).toBe(false);
		expect(markerStatus(reply.body())).toBe("payment-failed");
	});

	it("settlement-failed: a valid auth whose settle returns unsuccessful sends a failure receipt", async () => {
		await routeIncoming(PAYMENT_ID, "rine.v1.x402_payment", paymentPayload());
		const reply = routeReply(PAYMENT_ID);
		routeFacilitator(
			{ isValid: true, payer: "0x1111" },
			{
				success: false,
				transaction: "",
				network: "base-sepolia",
				payer: "0x1111",
				errorReason: "insufficient_funds",
			},
		);

		const out = await runTool(fulfillTool(), { messageId: PAYMENT_ID }, h);

		expect(out).toContain("status: settlement-failed");
		expect(out).toContain("insufficient_funds");
		expect(markerStatus(reply.body())).toBe("payment-failed");
	});

	it("facilitator-error: an HTTP failure is a typed status, and no receipt is sent", async () => {
		await routeIncoming(PAYMENT_ID, "rine.v1.x402_payment", paymentPayload());
		const reply = routeReply(PAYMENT_ID);
		h.route("POST", /^\/verify$/, () => ({
			status: 502,
			json: { error: "bad gateway" },
		}));

		const out = await runTool(fulfillTool(), { messageId: PAYMENT_ID }, h);

		expect(out).toContain("status: facilitator-error");
		// No receipt was sent — the payer's thread stays open for a retry.
		expect(reply.body().type).toBeUndefined();
	});

	it("not-payment: a non-payment message is rejected before any facilitator call", async () => {
		await routeIncoming(PAYMENT_ID, "rine.v1.task_request", { text: "hi" });

		const out = await runTool(fulfillTool(), { messageId: PAYMENT_ID }, h);
		expect(out).toContain("status: not-payment");
		expect(h.requests.some((r) => r.path === "/verify")).toBe(false);
	});

	it("no-facilitator: nothing configured returns no-facilitator without touching the network", async () => {
		await routeIncoming(PAYMENT_ID, "rine.v1.x402_payment", paymentPayload());
		const tool = createRineFulfillTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		}); // no facilitator

		const out = await runTool(tool, { messageId: PAYMENT_ID }, h);
		expect(out).toContain("status: no-facilitator");
		expect(h.requests.some((r) => r.path === "/verify")).toBe(false);
	});
});
