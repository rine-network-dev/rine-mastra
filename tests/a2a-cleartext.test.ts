/**
 * An A2A message that arrived as cleartext says so wherever its body is shown or
 * handed to the model: the single read, the inbox row, and the resume data a
 * suspended workflow step receives. A sealed message renders exactly as before.
 */

import { A2A_CLEARTEXT_NOTICE } from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";
import {
	renderInbox,
	renderMessageBody,
	renderSingleMessage,
} from "../src/format.js";
import { RineThreadResumer } from "../src/inbound.js";
import { InMemoryThreadMap } from "../src/threadmap.js";
import type { DecryptedMessage } from "../src/types.js";
import { makeInbound } from "./harness.js";

const LEAD = `[${A2A_CLEARTEXT_NOTICE}] `;

function msg(over: Partial<DecryptedMessage> = {}): DecryptedMessage {
	return {
		id: "m-1",
		conversation_id: "c-1",
		type: "rine.v1.a2a_message",
		encrypted_payload: "OPAQUE",
		encryption_version: "none",
		metadata: {},
		created_at: "2026-10-13T00:00:00.000Z",
		verified: false,
		verification_status: "unverifiable",
		plaintext: [{ text: "plain" }],
		sender_handle: "ext@example",
		decrypt_error: null,
		...over,
	} as DecryptedMessage;
}

describe("A2A cleartext in rendered bodies", () => {
	it("test_render_message_body_when_a2a_cleartext_then_leads_with_notice", () => {
		expect(renderMessageBody(msg()).startsWith(LEAD)).toBe(true);
	});

	it("test_render_single_message_when_a2a_cleartext_then_body_carries_notice_and_no_verified_claim", () => {
		const out = renderSingleMessage(msg());
		expect(out).toContain(`body: ${LEAD}`);
		expect(out).not.toContain("signature verified");
	});

	it("test_render_inbox_when_a2a_cleartext_then_row_carries_notice", () => {
		expect(renderInbox([msg()])).toContain(LEAD);
	});

	it("test_render_message_body_when_sealed_then_unchanged", () => {
		const sealed = msg({
			type: "rine.v1.text",
			encryption_version: "hpke-hybrid-v2",
			plaintext: { text: "hello" },
		} as never);
		expect(renderMessageBody(sealed)).toBe("hello");
		const noneButNotA2a = msg({ type: "rine.v1.text", plaintext: { text: "hi" } } as never);
		expect(renderMessageBody(noneButNotA2a)).toBe("hi");
	});
});

describe("A2A cleartext in the resume data", () => {
	async function resumeDataFor(over: Record<string, unknown>) {
		const resume = vi.fn(async () => undefined);
		const workflow = {
			getWorkflowRunById: vi.fn(async () => ({ status: "suspended" })),
			createRun: vi.fn(async () => ({ resume })),
		};
		const map = new InMemoryThreadMap();
		await map.set("bob@acme", "c1", "run-1");
		const resumer = new RineThreadResumer({
			workflow,
			threadMap: map,
			logger: { debug: vi.fn(), warn: vi.fn() },
		});
		await resumer.handleInbound(makeInbound(over));
		return (resume.mock.calls[0] as unknown as [{ resumeData: { plaintext: string; verified: boolean } }])[0].resumeData;
	}

	it("test_resume_data_when_a2a_cleartext_then_plaintext_leads_with_notice_and_is_unverified", async () => {
		const data = await resumeDataFor({
			type: "rine.v1.a2a_message",
			encryption_version: "none",
			plaintext: [{ text: "plain" }],
			verified: false,
			verification_status: "unverifiable",
		});
		expect(data.plaintext.startsWith(LEAD)).toBe(true);
		expect(data.verified).toBe(false);
	});
});
