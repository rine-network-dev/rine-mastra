/**
 * Zod input schemas for the two x402 payment tools (`rine_pay`, `rine_fulfill`).
 *
 * One file per domain (mirrors `schemas-groups.ts`) to keep `schemas.ts` within
 * the ~200-LOC budget; re-exported from `schemas.ts` so the schema entry point
 * stays single. Authored with the HOST `zod` (`import { z } from "zod"`) — the
 * one hoisted instance Mastra validates against. Identity/credentials NEVER
 * appear here — an input schema is model-visible and model-controllable, so the
 * acting agent + config dir come from `ctx.requestContext` instead.
 *
 * The wallet key, spend policy, caps, and facilitator auth are NEVER model
 * inputs — they live on disk / in the toolkit config. A tool input can name a
 * facilitator PRESET or base URL, but never carries key material or provider auth.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// rine_pay (payer) — mirrors the MCP `rine_pay` schema (parity across surfaces)
// ---------------------------------------------------------------------------

export const payInput = z.object({
	messageId: z
		.string()
		.describe(
			"UUID of the received `rine.v1.x402_payment_required` quote to pay. The tool decrypts it, selects an acceptable requirement under the agent's local spend policy (deny-by-default), signs an EIP-3009 stablecoin authorization with the agent's wallet, and sends the signed payment back IN-THREAD.",
		),
	autoPay: z
		.boolean()
		.optional()
		.describe(
			"If true, pay ONLY when the quote is at/below the policy's autoPayThreshold; otherwise return `above-auto-pay-threshold` without paying. Default follows the toolkit's `payments.autoPay` config (default false — an explicit pay call is the authorization, still bounded by the hard spend caps).",
		),
	emitMarker: z
		.boolean()
		.optional()
		.describe(
			"Attach the cleartext status marker (metadata['rine.x402']). Default true. The marker carries only coarse lifecycle state (never amounts/assets/addresses). Set false for a fully-sealed send.",
		),
	allowRepay: z
		.boolean()
		.optional()
		.describe(
			"If true, re-pay a quote already paid today, bypassing the once-per-message guard (a deliberate second, PERMANENT debit). Default false — a repeat pay of the same messageId returns `already-paid` without spending.",
		),
});

// ---------------------------------------------------------------------------
// rine_fulfill (payee) — verify → settle → send receipt in-thread
// ---------------------------------------------------------------------------

export const fulfillInput = z.object({
	messageId: z
		.string()
		.describe(
			"UUID of the received `rine.v1.x402_payment` message to fulfill. The tool verifies the signed authorization with the configured facilitator, settles it on-chain (settle-first), and sends the settlement receipt back IN-THREAD. A failed verification skips settlement and sends a failure receipt so the payer's thread reaches a terminal state.",
		),
	facilitator: z
		.string()
		.optional()
		.describe(
			"Optional facilitator override: a preset key (`cdp`, `payai`, `x402-rs`) or an `https://` base URL. Omit to use the toolkit's configured facilitator. NOTE: provider auth (e.g. CDP keys) is supplied only via toolkit config, never here — a keyless facilitator like `payai` needs no auth.",
		),
	emitMarker: z
		.boolean()
		.optional()
		.describe(
			"Attach the cleartext status marker on the receipt (default true). Coarse lifecycle state only, never economic detail.",
		),
});
