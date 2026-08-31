/**
 * Shared Zod input schemas for the 25 rine tools.
 *
 * Authored with the HOST `zod` (`import { z } from "zod"`) — the single hoisted
 * instance Mastra validates against — NOT the SDK's re-exported `z`. Rich
 * `.describe()` on EVERY field: the field descriptions are the #1 lever on
 * tool-call accuracy (the AI-DX). Identity/credentials NEVER appear here — the
 * acting agent + config dir are read from `ctx.requestContext`, never the model-
 * visible input schema, which the model both sees and controls (also Mastra's
 * own security rule).
 *
 * `messageType`/`idempotencyKey`/etc. ports drop the Python `tag`/`jurisdiction`/
 * `pricingModel` discover fields (the TS `DiscoveryFilters` lacks them) and add
 * `enableMls` (default true) on group_create — the headline inversion.
 */

import { THREAD_REF_SURFACES, threadRefRequiredRefusal } from "@rine-network/core";
import { z } from "zod";

const DEFAULT_MESSAGE_TYPE = "rine.v1.task_request";
const DEFAULT_REPLY_TYPE = "rine.v1.task_response";

/**
 * The exactly-one-of rule for `rine_thread`'s two references, in the words the
 * refusal will use if it is broken.
 *
 * One string teaches the schema and answers the mistake, so the model can never
 * be told a rule the product does not enforce. Its spellings come from
 * `rine-core` — these tools name the two references exactly as the TypeScript
 * SDK does (`group` / `conversationId`), which is what `THREAD_REF_SURFACES.sdk`
 * holds.
 */
export const THREAD_REF_RULE = threadRefRequiredRefusal(
	THREAD_REF_SURFACES.sdk,
);

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export const threadInput = z.object({
	group: z
		.string()
		.optional()
		.describe(
			`The group whose transcript to read: its handle (#logistics@acme.rine.network), its name, or its UUID. Returns every turn since this agent was seated, decrypted and role-tagged, oldest→newest. ${THREAD_REF_RULE}`,
		),
	conversationId: z
		.string()
		.optional()
		.describe(
			`The UUID of the conversation to fetch the transcript of. Returns every turn (yours and the peer's) decrypted and role-tagged, oldest→newest. ${THREAD_REF_RULE}`,
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe(
			"Optional max number of most-recent turns to return (1–100). Omit for the server default.",
		),
});

export const sendInput = z.object({
	to: z
		.string()
		.describe(
			"Recipient handle/UUID, or a group. Examples: `kofi@acme.rine.network` for one agent; `#logistics@acme.rine.network`, or just `logistics`, for a group. A group target sends to the whole group over its E2EE channel (MLS or sender-key, chosen automatically). A bare name that is one of your own agents' is refused rather than posted, and the refusal prints the handle that would have sent the 1:1.",
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
			"Recipient agent address (1:1 ONLY): a handle `kofi@acme.rine.network` or a UUID. Group handles (`#…`) are NOT supported here — use rine_send for groups.",
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

export const inboxInput = z.object({
	// `all` is a TOOL-layer value with no counterpart on the wire: the server's
	// filter is a three-value literal, and "everything" is the absence of the
	// parameter. The tool body translates it; it is never sent.
	status: z
		.enum(["new", "delivered", "read", "all"])
		.default("new")
		.describe(
			"Which messages to fetch (default `new`). `new` is the mail this agent has not acknowledged yet, and it is the ONLY value that marks what it returns delivered. `delivered` and `read` re-read mail already acknowledged, and `all` drops the filter entirely; none of the three marks anything.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe(
			"Maximum number of messages to fetch and decrypt (1–100, default 20). On the default `new` status the fetched messages are marked delivered, so a later check returns only newer mail.",
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

// One schema file per domain keeps every one of them within the ~200-LOC
// budget; all of them are re-exported here so existing `./schemas.js`
// importers and `index.ts` keep a single schema entry point. The three group
// READ schemas sit in their own module beside the tools that use them.
export {
	discoverInput,
	inspectInput,
	whoamiInput,
} from "./schemas-discovery.js";
export {
	discoverGroupsInput,
	groupRosterInput,
	groupsInput,
} from "./schemas-groups-list.js";
export {
	groupCreateInput,
	groupInspectInput,
	groupInviteInput,
	groupInvitesInput,
	groupJoinInput,
	groupLeaveInput,
	groupReclaimInput,
	groupRemoveInput,
	groupRequestsInput,
	groupSyncInput,
	groupVoteInput,
} from "./schemas-groups.js";
export { fulfillInput, payInput } from "./schemas-payments.js";
