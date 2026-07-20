/**
 * The 2 x402 payment tools: `rine_pay` (payer) and `rine_fulfill` (payee). Each
 * is a thin `createTool` adapter over the ts-sdk `client.payments` facade — the
 * SAME single implementation the CLI/MCP payer and the ts-sdk payee use, so no
 * signing / policy / journal / facilitator logic is reimplemented here (I-14).
 *
 * `rine_pay` consumes a received `rine.v1.x402_payment_required` and returns the
 * `rine_pay` 7-status vocabulary VERBATIM (parity with MCP `rine_pay` and the
 * cc-plugin skill). `rine_fulfill` consumes a received `rine.v1.x402_payment`,
 * verifies + settles via the configured facilitator (plain external HTTP, never
 * rine), sends the receipt in-thread, and returns the PINNED payee vocabulary
 * (`settled` / `settlement-failed` / `verification-failed` / `facilitator-error`
 * / `no-facilitator` / `not-payment`), identical across every surface
 * (CLI/MCP/eve/mastra).
 *
 * Invariants held: deny-by-default policy; sign → reserve LAST → transmit;
 * permanent debit (no retry-with-fresh-reserve loop — a single `pay` call);
 * marker `{status,rail}`-only, default ON; wallet key never surfaced; typed
 * outcomes never throw for an expected refusal; the settlement `.network` is
 * stored/echoed verbatim, never CAIP-2 string-matched (PayAI echoes the v1 slug).
 */

import { createTool } from "@mastra/core/tools";
import {
	FACILITATOR_PRESET,
	type FacilitatorConfig,
	X402Error,
	X402FacilitatorError,
	X402_ERROR,
	X402_MESSAGE_TYPE,
} from "@rine-network/core";
import { asMessageUuid } from "@rine-network/sdk";
import { strResult, type z } from "./_zod.js";
import { fulfillInput, payInput } from "./schemas-payments.js";
import { type RinePaymentToolOpts, makeExecute } from "./tool.js";

/** The `rine_pay` 7-status vocabulary — reused VERBATIM from MCP `rine_pay`. */
const PAY_STATUS = {
	SUBMITTED: "payment-submitted",
	NO_WALLET: "no-wallet",
	NOT_PAYMENT_REQUIRED: "not-payment-required",
	POLICY_REFUSED: "policy-refused",
	ABOVE_AUTO_PAY_THRESHOLD: "above-auto-pay-threshold",
	ALREADY_PAID: "already-paid",
	WALLET_BUSY: "wallet-busy",
} as const;

/**
 * The `rine_fulfill` payee statuses — PINNED across every surface (CLI/MCP/eve/
 * mastra) so an LLM or operator script parses one vocabulary everywhere. Mirrors
 * the MCP `rine_fulfill` reference set; mastra emits the subset the ts-sdk
 * `fulfill` facade can reach (it owns decryption, so `no-keys` never surfaces).
 */
const FULFILL_STATUS = {
	SETTLED: "settled",
	SETTLEMENT_FAILED: "settlement-failed",
	VERIFICATION_FAILED: "verification-failed",
	FACILITATOR_ERROR: "facilitator-error",
	NO_FACILITATOR: "no-facilitator",
	NOT_PAYMENT: "not-payment",
} as const;

/** Node's fs "no such file" error carries `code === "ENOENT"`. */
function isMissingFile(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

/**
 * Map a thrown pay refusal to a typed `status:` line, or `null` for an
 * unexpected error (which bubbles to `makeExecute`'s `formatError`). A missing
 * wallet key surfaces as `no-wallet`; `X402Error` codes map to the shared
 * vocabulary. A top-level `per-tx-cap-exceeded` can only come from the auto-pay
 * gate (`selectRequirement` wraps per-candidate refusals in
 * `no-acceptable-requirement`), so it maps to `above-auto-pay-threshold`.
 */
function payStatusFromError(err: unknown): string | null {
	if (isMissingFile(err)) {
		return `status: ${PAY_STATUS.NO_WALLET} — no wallet for this agent; create one before paying.`;
	}
	if (!(err instanceof X402Error)) return null;
	switch (err.code) {
		case X402_ERROR.ALREADY_PAID:
			return `status: ${PAY_STATUS.ALREADY_PAID} — ${err.message}`;
		case X402_ERROR.WALLET_BUSY:
			return `status: ${PAY_STATUS.WALLET_BUSY} — ${err.message}`;
		case X402_ERROR.PER_TX_CAP_EXCEEDED:
			return `status: ${PAY_STATUS.ABOVE_AUTO_PAY_THRESHOLD} — ${err.message}`;
		default: {
			// `selectRequirement` wraps the specific per-candidate rejection in
			// `details.reason`; surface that actionable code, not the wrapper.
			const reason =
				typeof err.details?.reason === "string" ? err.details.reason : err.code;
			return `status: ${PAY_STATUS.POLICY_REFUSED} (${reason}) — ${err.message}`;
		}
	}
}

/**
 * `rine_pay` — pay a received x402 quote in-thread (payer). Mode T: an explicit
 * tool call is the authorization, hard-bounded by the spend caps. The toolkit's
 * `payments.autoPay` config (D2, default OFF) sets the default of the `autoPay`
 * input; when on, only quotes at/below the policy's `autoPayThreshold` are paid.
 */
export function createRinePayTool(opts: RinePaymentToolOpts = {}) {
	return createTool({
		id: "rine_pay",
		description:
			"Pay a received x402 payment request (rine.v1.x402_payment_required) in-thread. Decrypts the quote, selects an acceptable requirement under the agent's local spend policy (deny-by-default), signs an EIP-3009 stablecoin authorization with the agent's wallet, and sends the signed rine.v1.x402_payment back in the same conversation. The spend is reserved under a cross-process lock as the last act before the send (fail-closed: the debit stands even if the send then fails, and there is no refund). Returns a typed `status:` line — `payment-submitted` on success, or `no-wallet` / `not-payment-required` / `policy-refused` / `above-auto-pay-threshold` / `already-paid` / `wallet-busy`. It does NOT wait for settlement: the receipt arrives later as an ordinary inbox message (read it with rine_read / rine_check_inbox / rine_thread).",
		inputSchema: payInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof payInput>>(opts, async (client, i) => {
			const quote = await client.read(asMessageUuid(i.messageId));
			if (quote.type !== X402_MESSAGE_TYPE.PAYMENT_REQUIRED) {
				return `status: ${PAY_STATUS.NOT_PAYMENT_REQUIRED} — message ${i.messageId} is type '${quote.type}', not ${X402_MESSAGE_TYPE.PAYMENT_REQUIRED}.`;
			}
			try {
				const res = await client.payments.pay(quote, {
					agent: opts.agent,
					autoPay: i.autoPay ?? opts.autoPay ?? false,
					emitMarker: i.emitMarker,
					allowRepay: i.allowRepay,
				});
				const r = res.requirement;
				return `status: ${PAY_STATUS.SUBMITTED} — sent payment ${res.payment.id} in conversation ${res.payment.conversation_id} (${r.amount} ${r.asset} on ${r.network} to ${r.payTo}). The settlement receipt arrives later as an inbox message.`;
			} catch (err) {
				const mapped = payStatusFromError(err);
				if (mapped) return mapped;
				throw err;
			}
		}),
	});
}

/** Resolve a facilitator spec (preset key | https URL | config object) → config. */
function resolveFacilitator(
	spec: string | FacilitatorConfig | undefined,
): FacilitatorConfig | null {
	if (!spec) return null;
	if (typeof spec !== "string") return spec;
	if (spec in FACILITATOR_PRESET) {
		return FACILITATOR_PRESET[spec as keyof typeof FACILITATOR_PRESET];
	}
	if (/^https?:\/\//.test(spec)) return { url: spec };
	return null;
}

/**
 * `rine_fulfill` — verify + settle a received x402 payment and send the receipt
 * in-thread (payee). Settle-first: on a valid authorization it settles via the
 * configured facilitator and sends a success receipt; on an invalid one it skips
 * settlement and sends a failure receipt so the payer reaches a terminal state.
 * The facilitator is plain external HTTP (never rine); its `.network` slug is
 * echoed verbatim.
 */
export function createRineFulfillTool(opts: RinePaymentToolOpts = {}) {
	return createTool({
		id: "rine_fulfill",
		description:
			"Fulfill a received x402 payment (rine.v1.x402_payment) as the payee. Verifies the signed EIP-3009 authorization with the configured facilitator (an EXTERNAL settlement service, never rine), settles it on-chain, and sends the settlement receipt back in the same conversation. A failed verification skips settlement and sends a failure receipt so the payer's thread reaches a terminal state. Returns a typed `status:` line — `settled` (with the on-chain tx), else `settlement-failed` / `verification-failed` / `facilitator-error` / `no-facilitator` / `not-payment`. Configure the facilitator on the toolkit (`payments.facilitator`) or pass a preset key / base URL.",
		inputSchema: fulfillInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof fulfillInput>>(
			opts,
			async (client, i) => {
				const payment = await client.read(asMessageUuid(i.messageId));
				if (payment.type !== X402_MESSAGE_TYPE.PAYMENT) {
					return `status: ${FULFILL_STATUS.NOT_PAYMENT} — message ${i.messageId} is type '${payment.type}', not ${X402_MESSAGE_TYPE.PAYMENT}.`;
				}
				const facilitator = resolveFacilitator(
					i.facilitator ?? opts.facilitator,
				);
				if (!facilitator) {
					return `status: ${FULFILL_STATUS.NO_FACILITATOR} — configure the toolkit's \`payments.facilitator\` (a preset key \`cdp\`/\`payai\`/\`x402-rs\` or a base URL) before fulfilling.`;
				}
				try {
					const res = await client.payments.fulfill(payment, {
						facilitator,
						agent: opts.agent,
						emitMarker: i.emitMarker,
					});
					// `.network` is echoed verbatim from the facilitator (the v1 slug,
					// e.g. `base-sepolia`) — never CAIP-2 string-matched.
					if (!res.verification.isValid) {
						const reason =
							res.verification.invalidReason ?? "verification_failed";
						return `status: ${FULFILL_STATUS.VERIFICATION_FAILED} (${reason}) — settlement skipped; failure receipt ${res.receipt.id} sent in-thread.`;
					}
					const s = res.settlement;
					if (s?.success) {
						return `status: ${FULFILL_STATUS.SETTLED} — settled on ${s.network} (tx ${s.transaction}); receipt ${res.receipt.id} sent in-thread.`;
					}
					return `status: ${FULFILL_STATUS.SETTLEMENT_FAILED} (${s?.errorReason ?? "unknown"}) — receipt ${res.receipt.id} sent in-thread.`;
				} catch (err) {
					// A facilitator HTTP failure (no receipt sent) is a typed outcome,
					// not a thrown stack trace — parity with CLI/MCP/eve.
					if (err instanceof X402FacilitatorError) {
						return `status: ${FULFILL_STATUS.FACILITATOR_ERROR} — ${err.message}`;
					}
					throw err;
				}
			},
		),
	});
}
