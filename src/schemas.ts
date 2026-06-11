/**
 * Shared Zod input schemas for the 11 rine tools.
 *
 * Authored with the HOST `zod` (`import { z } from "zod"`) — the single hoisted
 * instance Mastra validates against — NOT the SDK's re-exported `z`. Rich
 * `.describe()` on EVERY field: the field descriptions are the #1 lever on
 * tool-call accuracy (the AI-DX). Identity/credentials NEVER appear here — the
 * acting agent + config dir are read from `ctx.requestContext`, never the model-
 * visible input schema (I-2 / Mastra's own security rule).
 *
 * `messageType`/`idempotencyKey`/etc. ports drop the Python `tag`/`jurisdiction`/
 * `pricingModel` discover fields (the TS `DiscoveryFilters` lacks them) and add
 * `enableMls` (default true) on group_create — the headline inversion (D-mls).
 */

import { z } from "zod";

const DEFAULT_MESSAGE_TYPE = "rine.v1.task_request";
const DEFAULT_REPLY_TYPE = "rine.v1.task_response";

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export const sendInput = z.object({
	to: z
		.string()
		.describe(
			"Recipient address: a 1:1 agent handle `name@org`, a UUID, or a group handle prefixed with `#` (e.g. `#ops@acme`). A `#` target sends to the whole group over its E2EE channel (MLS or sender-key, chosen automatically).",
		),
	body: z
		.string()
		.describe(
			"The plaintext message text to send. It is end-to-end encrypted before transmission.",
		),
	messageType: z
		.string()
		.default(DEFAULT_MESSAGE_TYPE)
		.describe(
			"The rine message type, e.g. `rine.v1.task_request` (default) or `rine.v1.text`. Leave as the default unless you know the recipient expects a specific type.",
		),
	idempotencyKey: z
		.string()
		.optional()
		.describe(
			"Optional idempotency key. Reusing the same key for a retry prevents a duplicate send if the first attempt's response was lost.",
		),
});

export const sendAndWaitInput = z.object({
	to: z
		.string()
		.describe(
			"Recipient agent address (1:1 ONLY): a handle `name@org` or a UUID. Group handles (`#…`) are NOT supported here — use rine_send for groups.",
		),
	body: z
		.string()
		.describe(
			"The plaintext message text to send. End-to-end encrypted before transmission.",
		),
	waitSeconds: z
		.number()
		.int()
		.min(1)
		.max(300)
		.default(30)
		.describe(
			"How long to block waiting for a reply, in SECONDS (1–300, default 30). Returns the reply if one arrives in time, otherwise a 'no reply' note.",
		),
	messageType: z
		.string()
		.default(DEFAULT_MESSAGE_TYPE)
		.describe(`The rine message type (default \`${DEFAULT_MESSAGE_TYPE}\`).`),
});

export const checkInboxInput = z.object({
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe(
			"Maximum number of new messages to fetch and decrypt (1–100, default 20). Fetched messages are marked delivered so a later check returns only newer mail.",
		),
});

export const readInput = z.object({
	messageId: z
		.string()
		.describe(
			"The UUID of the message to fetch and decrypt. Returns the decrypted body and signature status.",
		),
});

export const replyInput = z.object({
	messageId: z
		.string()
		.describe(
			"The UUID of the message you are replying to. The reply threads into the same conversation.",
		),
	body: z
		.string()
		.describe(
			"The plaintext reply text. End-to-end encrypted before transmission.",
		),
	messageType: z
		.string()
		.default(DEFAULT_REPLY_TYPE)
		.describe(
			`The rine message type for the reply (default \`${DEFAULT_REPLY_TYPE}\`).`,
		),
});

// ---------------------------------------------------------------------------
// Discovery (unauthenticated)
// ---------------------------------------------------------------------------

export const discoverInput = z.object({
	q: z
		.string()
		.optional()
		.describe(
			"Free-text search query matched against agent names, handles, and descriptions.",
		),
	category: z
		.string()
		.optional()
		.describe("Filter by agent category (e.g. `research`, `support`)."),
	language: z
		.string()
		.optional()
		.describe("Filter by the agent's working language (e.g. `en`, `de`)."),
	verified: z
		.boolean()
		.optional()
		.describe(
			"When true, return only verified agents; when false, only unverified; omit for both.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(10)
		.describe("Maximum number of agents to return (1–100, default 10)."),
});

export const inspectInput = z.object({
	handleOrId: z
		.string()
		.describe(
			"An agent handle (`name@org`, resolved via WebFinger) or a UUID. Returns the full public profile.",
		),
});

// Group input schemas live in `schemas-groups.ts` (one file per domain; keeps
// this file within the ~200-LOC budget). They are re-exported here so existing
// `./schemas.js` importers and `index.ts` keep a single schema entry point.
export {
	groupCreateInput,
	groupInspectInput,
	groupInviteInput,
	groupRemoveInput,
} from "./schemas-groups.js";
