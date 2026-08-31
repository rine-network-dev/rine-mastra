/**
 * The 6 messaging tools: `rine_send`, `rine_send_and_wait`, `rine_inbox`,
 * `rine_read`, `rine_thread`, `rine_reply`. Each is a thin
 * `createTool` adapter: one `AsyncRineClient` call rendered to a string, wrapped
 * by `makeExecute` (lazy client + formatError). Identity comes from
 * `ctx.requestContext`, never the model-visible `inputSchema`.
 *
 * Ciphertext never reaches the model through any of them: renderers read only
 * plaintext/decrypt_error/verification (`format.ts`), never the ciphertext
 * envelope. `rine_inbox` on its default
 * `new` status is the Track-0 poll+ack receive primitive (Tier-1).
 */

import { createTool } from "@mastra/core/tools";
import { THREAD_REF_SURFACES, resolveThreadRef } from "@rine-network/core";
import { asMessageUuid } from "@rine-network/sdk";
import { strResult, type z } from "./_zod.js";
import { GROUP_ON_WAIT_MESSAGE, isGroupUnsupportedOnWait } from "./errors.js";
import {
	renderInbox,
	renderMessageBody,
	renderSingleMessage,
	renderThread,
	verifiedNote,
} from "./format.js";
import {
	THREAD_REF_RULE,
	inboxInput,
	readInput,
	replyInput,
	sendAndWaitInput,
	sendInput,
	threadInput,
} from "./schemas.js";
import {
	type RineToolOpts,
	asRecipient,
	makeExecute,
	redactToText,
} from "./tool.js";

/** `rine_send` — send a 1:1 or group message (the SDK auto-routes groups). */
export function createRineSendTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_send",
		description:
			"Start a NEW conversation: send an end-to-end-encrypted message to another agent (`kofi@acme.rine.network` / UUID) or to a whole group over its E2EE channel — name the group by its own name (`logistics`), or by its full handle (`#logistics@acme.rine.network`). Use this to open a fresh thread, NOT to answer an inbound message — to continue an existing conversation use rine_reply (which keeps the same thread). This is a real, irreversible network action: the message is delivered to a live recipient. Returns the new message id and conversation id.",
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
			"Send an end-to-end-encrypted message to a single agent (`kofi@acme.rine.network` / UUID) and block up to `waitSeconds` for a reply, returning the decrypted reply if one arrives. 1:1 only — use rine_send for groups. This is a real, irreversible network action.",
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
 * `rine_inbox` — poll the inbox under one status filter, decrypt what it
 * returns, and on the `new` path best-effort `markDelivered` the decryptable
 * ids so a later check returns only newer mail (Track-0 poll+ack, Tier-1). On
 * ack failure: warn + note the messages "may reappear" but still return the
 * reads.
 */
export function createRineInboxTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_inbox",
		description:
			'Fetch and decrypt messages from your inbox (1:1 and group). Defaults to `status: "new"` — the mail this agent has not acknowledged yet — and marks what it returns delivered, so a later check returns only newer mail. `delivered`, `read` and `all` re-read mail that was already acknowledged and mark nothing. Returns a numbered list of decrypted messages, or \'No new messages.\' when nothing matched.',
		inputSchema: inboxInput,
		outputSchema: strResult,
		// Belt-and-suspenders ciphertext redactor: the last of the three
		// defences keeping ciphertext out of the model's context.
		toModelOutput: redactToText,
		execute: makeExecute<z.infer<typeof inboxInput>>(
			opts,
			async (client, i) => {
				// The schema's default, restated for the path where a host calls
				// `execute` with raw input Mastra never validated: without it a
				// missing `status` would silently turn the poll+ack primitive into
				// an unfiltered read that acks nothing.
				const status = i.status ?? "new";
				// `all` is a tool-layer value: the server's filter is a three-value
				// literal and "everything" is the ABSENCE of the parameter, so it is
				// translated to an omitted `status` rather than forwarded.
				const page = await client.inbox({
					status: status === "all" ? undefined : status,
					limit: i.limit,
				});
				const items = page.items;
				const rendered = renderInbox(items);

				// Ack on the `new` path only. Every other filter is a re-read of mail
				// this agent has already acknowledged, so there is nothing to move —
				// and acking there would consume messages the caller asked only to see.
				if (status !== "new") return rendered;

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
		// Belt-and-suspenders ciphertext redactor: the last of the three
		// defences keeping ciphertext out of the model's context.
		toModelOutput: redactToText,
		execute: makeExecute<z.infer<typeof readInput>>(opts, async (client, i) => {
			const msg = await client.read(asMessageUuid(i.messageId));
			return renderSingleMessage(msg);
		}),
	});
}

/** `rine_thread` — fetch the both-sided, decrypted transcript of a conversation or a group. */
export function createRineThreadTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_thread",
		description: `Fetch the both-sided, decrypted transcript of a conversation or a group. ${THREAD_REF_RULE} Returns every turn ordered oldest→newest, each role-tagged (\`[sent] you:\` / \`[received] handle:\`). A turn you cannot decrypt renders \`[unavailable]\`, except one sealed under a sender key this agent does not hold, which says so on the first such turn and marks the rest. A group's transcript starts where the reading agent was seated. Use to recover the full context of a conversation or a group on demand.`,
		inputSchema: threadInput,
		outputSchema: strResult,
		// Belt-and-suspenders ciphertext redactor: the last of the three
		// defences keeping ciphertext out of the model's context.
		toModelOutput: redactToText,
		execute: makeExecute<z.infer<typeof threadInput>>(opts, async (client, i) => {
			// Decided here rather than left to the SDK: `client.thread`'s two call
			// shapes cannot carry both references at once, so a call naming both
			// would silently read one of them. The rule, the refusal and the
			// spellings are all `rine-core`'s.
			const ref = resolveThreadRef(
				{ group: i.group ?? null, conversationId: i.conversationId ?? null },
				THREAD_REF_SURFACES.sdk,
			);
			const entries =
				ref.kind === "group"
					? await client.thread({ group: ref.ref, limit: i.limit })
					: await client.thread(ref.conversationId, { limit: i.limit });
			return renderThread(entries);
		}),
	});
}

/** `rine_reply` — reply to a message, threading into the same conversation. */
export function createRineReplyTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_reply",
		description:
			"Continue the SAME conversation (reply-in-place): send an end-to-end-encrypted reply to a message by its UUID, keeping it in that message's existing thread (no new conversation is forked). This is the right tool to answer an inbound message. This is a real, irreversible network action. Returns the reply's message id.",
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
