/**
 * The 5 messaging tools: `rine_send`, `rine_send_and_wait`, `rine_check_inbox`,
 * `rine_read`, `rine_reply` (SPEC §6 messaging table). Each is a thin
 * `createTool` adapter: one `AsyncRineClient` call rendered to a string, wrapped
 * by `makeExecute` (lazy client + formatError). Identity comes from
 * `ctx.requestContext`, never the model-visible `inputSchema`.
 *
 * I-2 holds throughout: renderers read only plaintext/decrypt_error/verification
 * (`format.ts`), never the ciphertext envelope. `rine_check_inbox` is the
 * Track-0 poll+ack receive primitive (Tier-1).
 */

import { createTool } from "@mastra/core/tools";
import { asMessageUuid } from "@rine-network/sdk";
import { strResult, type z } from "./_zod.js";
import { GROUP_ON_WAIT_MESSAGE, isGroupUnsupportedOnWait } from "./errors.js";
import {
	renderInbox,
	renderMessageBody,
	renderSingleMessage,
	verifiedNote,
} from "./format.js";
import {
	checkInboxInput,
	readInput,
	replyInput,
	sendAndWaitInput,
	sendInput,
} from "./schemas.js";
import {
	type RineToolOpts,
	asRecipient,
	makeExecute,
	redactToText,
} from "./tool.js";

/** `rine_send` — send a 1:1 or `#`-group message (the SDK auto-routes groups). */
export function createRineSendTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_send",
		description:
			"Send an end-to-end-encrypted message to another agent (`name@org` / UUID) or, with a `#`-prefixed handle, to a whole group over its E2EE channel. This is a real, irreversible network action: the message is delivered to a live recipient. Returns the new message id and conversation id.",
		inputSchema: sendInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof sendInput>>(opts, async (client, i) => {
			const msg = await client.send(
				asRecipient(i.to),
				{ text: i.body },
				{ type: i.messageType, idempotencyKey: i.idempotencyKey },
			);
			return `Sent message ${msg.id} to ${i.to} (conversation ${msg.conversation_id}).`;
		}),
	});
}

/** `rine_send_and_wait` — 1:1 send that blocks for a reply (Tier-2, ms timeout). */
export function createRineSendAndWaitTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_send_and_wait",
		description:
			"Send an end-to-end-encrypted message to a single agent (`name@org` / UUID) and block up to `waitSeconds` for a reply, returning the decrypted reply if one arrives. 1:1 only — use rine_send for groups. This is a real, irreversible network action.",
		inputSchema: sendAndWaitInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof sendAndWaitInput>>(
			opts,
			async (client, i) => {
				try {
					const { sent, reply } = await client.sendAndWait(
						asRecipient(i.to),
						{ text: i.body },
						{ timeout: i.waitSeconds * 1000, type: i.messageType },
					);
					if (!reply) {
						return `Sent ${sent.id}; no reply within ${i.waitSeconds}s.`;
					}
					return `Reply: ${renderMessageBody(reply)} (${verifiedNote(reply)})`;
				} catch (err) {
					// The group-handle case is a plain Error thrown BEFORE any HTTP
					// call — translate it to the 1:1-only guidance, not a stack trace.
					if (isGroupUnsupportedOnWait(err)) return GROUP_ON_WAIT_MESSAGE;
					throw err;
				}
			},
		),
	});
}

/**
 * `rine_check_inbox` — poll the newest new messages, decrypt them, then
 * best-effort `markDelivered` the decryptable ids so a later check returns only
 * newer mail (Track-0 poll+ack, Tier-1). On ack failure: warn + note the
 * messages "may reappear" but still return the reads (AC-5).
 */
export function createRineCheckInboxTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_check_inbox",
		description:
			"Fetch and decrypt your newest unread messages (1:1 and group), then mark them delivered so a later check returns only newer mail. Returns a numbered list of decrypted messages, or 'No new messages.'.",
		inputSchema: checkInboxInput,
		outputSchema: strResult,
		// I-2 layer (c): belt-and-suspenders ciphertext redactor (SPEC §2.2).
		toModelOutput: redactToText,
		execute: makeExecute<z.infer<typeof checkInboxInput>>(
			opts,
			async (client, i) => {
				const page = await client.inbox({ status: "new", limit: i.limit });
				const items = page.items;
				const rendered = renderInbox(items);

				// Ack only the messages we could actually decrypt; a broken envelope
				// stays "new" so a future poll can retry after key recovery.
				const decryptableIds = items
					.filter((m) => !m.decrypt_error)
					.map((m) => m.id);
				if (decryptableIds.length === 0) return rendered;

				try {
					await client.markDelivered(decryptableIds);
					return rendered;
				} catch {
					return `${rendered}\n[WARN] could not mark messages delivered; they may reappear on the next check.`;
				}
			},
		),
	});
}

/** `rine_read` — fetch + decrypt one message by id. */
export function createRineReadTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_read",
		description:
			"Fetch and decrypt a single message by its UUID. Returns the sender, type, decrypted body, and signature status.",
		inputSchema: readInput,
		outputSchema: strResult,
		// I-2 layer (c): belt-and-suspenders ciphertext redactor (SPEC §2.2).
		toModelOutput: redactToText,
		execute: makeExecute<z.infer<typeof readInput>>(opts, async (client, i) => {
			const msg = await client.read(asMessageUuid(i.messageId));
			return renderSingleMessage(msg);
		}),
	});
}

/** `rine_reply` — reply to a message, threading into the same conversation. */
export function createRineReplyTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_reply",
		description:
			"Send an end-to-end-encrypted reply to a message (by its UUID), threading into the same conversation. This is a real, irreversible network action. Returns the reply's message id.",
		inputSchema: replyInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof replyInput>>(
			opts,
			async (client, i) => {
				const reply = await client.reply(
					asMessageUuid(i.messageId),
					{ text: i.body },
					{ type: i.messageType },
				);
				return `Replied to ${i.messageId} -> ${reply.id}.`;
			},
		),
	});
}
