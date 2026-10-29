/**
 * Harness self-test: proves the load-bearing test foundation actually works —
 * a REAL HPKE envelope, produced by real rine-core crypto, round-trips back to
 * plaintext through the real SDK `client.read()` against the mock HTTP boundary.
 * If this passes, every later stage can trust `makeHarness()` exercises genuine
 * crypto — the ciphertext-absent and plaintext assertions elsewhere are made
 * against real envelopes, not stubs.
 */

import { encryptMessage } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Harness,
	PEER_AGENT_ID,
	PEER_HANDLE,
	SELF_AGENT_ID,
	SENTINEL_CIPHERTEXT,
	makeHarness,
} from "./harness.js";

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});

afterEach(() => {
	h.cleanup();
});

describe("harness", () => {
	it("round-trips a real HPKE envelope back to plaintext via client.read()", async () => {
		const env = await h.selfEncrypt({ text: "hello from the harness" });
		const messageId = "33333333-3333-4333-8333-333333333333";

		h.route("GET", new RegExp(`^/messages/${messageId}$`), () => ({
			json: {
				id: messageId,
				conversation_id: "44444444-4444-4444-8444-444444444444",
				from_agent_id: "22222222-2222-4222-8222-222222222222",
				to_agent_id: SELF_AGENT_ID,
				sender_handle: PEER_HANDLE,
				type: "rine.v1.task_request",
				encrypted_payload: env.encrypted_payload,
				encryption_version: env.encryption_version,
				sender_signing_kid: env.sender_signing_kid,
				content_type: "application/json",
				created_at: "2026-06-11T00:00:00.000Z",
			},
		}));

		// biome-ignore lint/suspicious/noExplicitAny: branded-id cast for test
		const msg = await h.client.read(messageId as any);

		expect(msg.decrypt_error ?? null).toBeNull();
		expect(msg.plaintext).toEqual({ text: "hello from the harness" });
		expect(msg.verified).toBe(true);
		expect(msg.verification_status).toBe("verified");
	});

	it("genuine ciphertext is opaque — sentinel never appears in plaintext", async () => {
		const env = await h.selfEncrypt({ text: SENTINEL_CIPHERTEXT });
		// The encrypted payload is real ciphertext, not the cleartext sentinel.
		expect(env.encrypted_payload).not.toContain(SENTINEL_CIPHERTEXT);
		expect(env.encryption_version).toBe("hpke-hybrid-v2");
	});

	it("records the observable HTTP boundary", async () => {
		const env = await h.selfEncrypt({ text: "hi" });
		const messageId = "55555555-5555-4555-8555-555555555555";
		h.route("GET", new RegExp(`^/messages/${messageId}$`), () => ({
			json: {
				id: messageId,
				conversation_id: "44444444-4444-4444-8444-444444444444",
				from_agent_id: "22222222-2222-4222-8222-222222222222",
				to_agent_id: SELF_AGENT_ID,
				type: "rine.v1.task_request",
				encrypted_payload: env.encrypted_payload,
				encryption_version: env.encryption_version,
				sender_signing_kid: env.sender_signing_kid,
				created_at: "2026-06-11T00:00:00.000Z",
			},
		}));
		// biome-ignore lint/suspicious/noExplicitAny: branded-id cast for test
		await h.client.read(messageId as any);

		const paths = h.requests.map((r) => `${r.method} ${r.path}`);
		expect(paths).toContain(`GET /messages/${messageId}`);
	});

	it("peerDecrypt refuses an envelope the bound sender did not sign", async () => {
		// Sealed to the peer but SIGNED by the peer, while `peerDecrypt` binds the
		// open to the self-agent as the sender — the re-sealed-message shape. The
		// decrypt withholds the body, so the harness must say so rather than hand a
		// test an empty plaintext.
		const env = await encryptMessage(
			h.configDir,
			PEER_AGENT_ID,
			PEER_AGENT_ID,
			{
				encryption: h.peerKeys.encryption.publicKey,
				pqEncryption: h.peerKeys.pqEncryption.publicKey,
			},
			{ text: "not signed by the self-agent" },
		);

		await expect(h.peerDecrypt(env.encrypted_payload)).rejects.toThrow(
			/refused the envelope \(sender-mismatch\)/,
		);
	});
});
