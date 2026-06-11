/**
 * Scripted responder for the live e2e (`e2e_live_agent.ts`). A `defineAgent`-
 * backed actor that auto-replies to every inbound message with a deterministic
 * acknowledgement echoing the request's nonce, so the live-LLM driver can assert
 * a unique value round-trips through the encrypted path.
 *
 * It is the "other side" of the conversation:
 *   - 1:1 `rine_send` / `rine_send_and_wait` from the driver → replied here.
 *   - MLS-group / sender-key group posts → replied into the group conversation.
 *   - Tier-3 demo: an inbound from the responder wakes the driver's suspended
 *     workflow run (the responder does the SENDING in that leg; see the live
 *     script for the resumer wiring).
 *
 * Built on the SDK's native SSE delivery (`defineAgent`) — no polling. The SDK
 * does all crypto; this file never touches an envelope (I-2: it reads
 * `msg.plaintext` only, replies in plaintext).
 *
 * NOT a unit test — it talks to a real rine server. The live e2e onboards a
 * throwaway org, runs this responder as a second agent, then erases the org.
 */

import {
	type AgentMessageContext,
	type AsyncRineClient,
	type DecryptedMessage,
	type GroupHandle,
	type RineAgent,
	defineAgent,
} from "@rine-network/sdk";
import { unwrapText } from "../src/format.js";

/** Options for {@link startResponder}. */
export interface ResponderOptions {
	/** A constructed, authenticated client for the responder agent. */
	client: AsyncRineClient;
	/**
	 * How to phrase the acknowledgement. Receives the unwrapped inbound body and
	 * must return the reply string (typically echoing a nonce). Defaults to
	 * `ack: <body>`.
	 */
	ack?: (inboundBody: string) => string;
	/** Optional logger; defaults to `console`. */
	logger?: Pick<Console, "debug" | "warn">;
}

/**
 * Start a scripted responder. Returns the live {@link RineAgent} handle — call
 * `.stop()` (or `await using`) to drain + close the SSE loop on teardown.
 *
 * I-1: the SSE loop is opened here (when explicitly started), never at import.
 */
export function startResponder(opts: ResponderOptions): RineAgent {
	const log = opts.logger ?? console;
	const ack = opts.ack ?? ((body: string) => `ack: ${body}`);

	return defineAgent({
		client: opts.client,
		onMessage: async (
			msg: DecryptedMessage,
			ctx: AgentMessageContext,
		): Promise<void> => {
			// I-2: read plaintext only; a message we can't read can't be acked sanely.
			if (msg.decrypt_error) {
				log.warn?.(`[responder] decrypt failed for ${msg.id}; skipping`);
				return;
			}
			const body = unwrapText(msg.plaintext);
			log.debug?.(`[responder] <- ${body} (msg ${msg.id})`);
			// Group messages can't be answered through the 1:1 reply endpoint —
			// it routes to "the other party" and 404s for a member who owns
			// neither end — so post a fresh message into the group (re-encrypted
			// mls-v1 by the SDK). 1:1 messages thread through the reply.
			if (msg.group_handle) {
				await ctx.client.send(msg.group_handle as GroupHandle, {
					text: ack(body),
				});
			} else {
				await ctx.reply({ text: ack(body) });
			}
		},
	});
}
