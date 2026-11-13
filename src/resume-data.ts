/** What a resumed Mastra step is handed for one inbound message, and the label it is keyed on. */

import { withA2aCleartextNotice } from "@rine-network/core";
import { unwrapText } from "./format.js";
import type { DecryptedMessage } from "./types.js";
import type { ResumeData } from "./workflow.js";

/**
 * The sender label used as the thread `handle` key and as `resumeData.from`.
 * Prefers the human handle, falls back to the agent UUID (matches `format.ts`).
 */
export function senderHandle(msg: DecryptedMessage): string | undefined {
	return msg.sender_handle ?? msg.from_agent_id ?? undefined;
}

/**
 * Plaintext and signature facts ONLY: JSON-serializable, never the ciphertext
 * envelope or an SDK client.
 */
export function resumeDataFor(
	msg: DecryptedMessage,
	handle: string,
): ResumeData {
	return {
		plaintext: withA2aCleartextNotice(msg, unwrapText(msg.plaintext)),
		verified: msg.verified,
		from: handle,
		messageId: msg.id,
	};
}
