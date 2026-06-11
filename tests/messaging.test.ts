/**
 * The 5 messaging tools, driven through their public Mastra `execute` interface
 * against the real SDK + real crypto + a mock HTTP boundary (SPEC §6 / §17).
 *
 * Covers: AC-1 (happy strings vs observable HTTP), AC-2 (error paths resolve,
 * never reject), AC-3/I-2 (ciphertext absent on every messaging path), AC-4
 * (group route + 1:1-only without an HTTP call), AC-5 (poll+ack incl. the
 * ack-failure "may reappear" warning), AC-9 (verified vs unverifiable).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRineCheckInboxTool,
	createRineReadTool,
	createRineReplyTool,
	createRineSendAndWaitTool,
	createRineSendTool,
} from "../src/messaging.js";
import {
	API_URL,
	type Harness,
	PEER_AGENT_ID,
	PEER_HANDLE,
	SELF_AGENT_ID,
	SENTINEL_CIPHERTEXT,
	makeHarness,
	runTool,
} from "./harness.js";

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});
afterEach(() => {
	h.cleanup();
});

const MSG_UUID = "33333333-3333-4333-8333-333333333333";
const CONV_UUID = "44444444-4444-4444-8444-444444444444";
const REPLY_UUID = "66666666-6666-4666-8666-666666666666";

/** A bare-envelope `POST /messages` ack the server returns for send/reply. */
function sentAck(id: string, conversationId = CONV_UUID) {
	return {
		id,
		conversation_id: conversationId,
		from_agent_id: SELF_AGENT_ID,
		to_agent_id: PEER_AGENT_ID,
		type: "rine.v1.task_request",
		encrypted_payload: "OPAQUE_SERVER_ECHO",
		encryption_version: "hpke-v1",
		created_at: "2026-06-11T00:00:00.000Z",
	};
}

describe("rine_send (AC-1, AC-3, AC-4 group route)", () => {
	it("sends a 1:1 message and returns the documented string", async () => {
		h.route("POST", /^\/messages$/, () => ({ json: sentAck(MSG_UUID) }));
		const tool = createRineSendTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		const out = await runTool(
			tool,
			{
				to: PEER_AGENT_ID,
				body: "hello world",
				messageType: "rine.v1.task_request",
			},
			h,
		);

		expect(out).toBe(
			`Sent message ${MSG_UUID} to ${PEER_AGENT_ID} (conversation ${CONV_UUID}).`,
		);
		// AC-1: the observable HTTP boundary shows the POST.
		const posts = h.requests.filter(
			(r) => r.method === "POST" && r.path === "/messages",
		);
		expect(posts).toHaveLength(1);
	});

	it("I-2: the wire body is ciphertext; the sentinel plaintext never appears in it", async () => {
		h.route("POST", /^\/messages$/, () => ({ json: sentAck(MSG_UUID) }));
		const tool = createRineSendTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		await runTool(tool, { to: PEER_AGENT_ID, body: SENTINEL_CIPHERTEXT }, h);

		const post = h.requests.find((r) => r.path === "/messages");
		const wire = JSON.stringify(post?.body);
		// The body that left the process is a genuine HPKE envelope — the cleartext
		// sentinel is NOT present (it was encrypted before transmission).
		expect(wire).not.toContain(SENTINEL_CIPHERTEXT);
		expect(wire).toContain("encrypted_payload");
	});

	it("AC-4: a `#`-group target routes through the SAME client.send (group path)", async () => {
		const GROUP_ID = "77777777-7777-4777-8777-777777777777";
		// The SDK resolves the group via GET /groups?handle=… (twice: once to read
		// the MLS latch, once inside the sender-key op). mls_group_id null ⇒ the
		// sender-key path.
		h.route("GET", /^\/groups$/, (req) => {
			expect(req.url).toContain("handle=");
			return {
				json: {
					items: [
						{
							id: GROUP_ID,
							name: "Ops",
							handle: "#ops@acme.rine.network",
							enrollment_policy: "closed",
							visibility: "private",
							created_at: "2026-06-11T00:00:00.000Z",
							mls_group_id: null,
						},
					],
					total: 1,
					next_cursor: null,
					prev_cursor: null,
				},
			};
		});
		// A single-member group (just the sender) ⇒ the sender-key is generated but
		// distributed to nobody, so no distribution POST is needed for this assertion.
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}/members$`), () => ({
			json: {
				items: [
					{
						group_id: GROUP_ID,
						agent_id: SELF_AGENT_ID,
						role: "owner",
						joined_at: "2026-06-11T00:00:00.000Z",
					},
				],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		h.route("POST", /^\/messages$/, () => ({
			json: sentAck(MSG_UUID, CONV_UUID),
		}));

		const tool = createRineSendTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{ to: "#ops@acme.rine.network", body: "team update" },
			h,
		);

		// Same call shape — the result string references the group target.
		expect(out).toContain("to #ops@acme.rine.network");
		// The body carried a `to_handle` (group route), not `to_agent_id`.
		const post = h.requests.find((r) => r.path === "/messages");
		expect(post?.body).toMatchObject({ to_handle: "#ops@acme.rine.network" });
		expect(post?.body).not.toHaveProperty("to_agent_id");
	});

	it("AC-2: a 404 from the wire resolves to a formatError string (never rejects)", async () => {
		h.route("POST", /^\/messages$/, () => ({
			status: 404,
			json: { detail: "no such agent" },
		}));
		const tool = createRineSendTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		const out = await runTool(tool, { to: PEER_AGENT_ID, body: "hi" }, h);
		expect(out).toContain("Not found: no such agent");
		expect(out).toContain("Try rine_discover");
	});
});

describe("rine_send_and_wait (AC-1, AC-4 1:1-only, AC-9)", () => {
	it("AC-1/AC-9: returns the decrypted reply + honest signature note", async () => {
		const env = await h.selfEncrypt({ text: "the answer is 42" });
		h.route("POST", /^\/messages\/sync$/, () => ({
			json: {
				message: sentAck(MSG_UUID),
				conversation_id: CONV_UUID,
				status: "replied",
				reply: {
					id: REPLY_UUID,
					conversation_id: CONV_UUID,
					from_agent_id: PEER_AGENT_ID,
					to_agent_id: SELF_AGENT_ID,
					sender_handle: PEER_HANDLE,
					type: "rine.v1.task_response",
					encrypted_payload: env.encrypted_payload,
					encryption_version: env.encryption_version,
					sender_signing_kid: env.sender_signing_kid,
					content_type: "application/json",
					created_at: "2026-06-11T00:00:00.000Z",
				},
			},
		}));

		const tool = createRineSendAndWaitTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{ to: PEER_AGENT_ID, body: "what is the answer?", waitSeconds: 30 },
			h,
		);

		expect(out).toContain("the answer is 42");
		expect(out).toContain("signature verified");
		// AC-3/I-2: the real ciphertext never appears in the returned string.
		expect(out).not.toContain(env.encrypted_payload);
	});

	it("waitSeconds is converted to MILLISECONDS on the wire (timeout_ms)", async () => {
		h.route("POST", /^\/messages\/sync$/, () => ({
			json: { message: sentAck(MSG_UUID), reply: null, status: "timeout" },
		}));
		const tool = createRineSendAndWaitTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		const out = await runTool(
			tool,
			{ to: PEER_AGENT_ID, body: "ping", waitSeconds: 5 },
			h,
		);
		expect(out).toBe(`Sent ${MSG_UUID}; no reply within 5s.`);
		const sync = h.requests.find((r) => r.path === "/messages/sync");
		// 5 seconds → 5000 ms.
		expect(sync?.url).toContain("timeout_ms=5000");
	});

	it("AC-4: a `#`-group target returns the 1:1-only string WITHOUT any HTTP call", async () => {
		const tool = createRineSendAndWaitTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const before = h.requests.length;
		const out = await runTool(
			tool,
			{ to: "#ops@acme.rine.network", body: "hi", waitSeconds: 10 },
			h,
		);
		expect(out).toBe("send_and_wait is 1:1 only; use rine_send for groups.");
		// The group guard is a synchronous throw before any request.
		expect(h.requests.length).toBe(before);
	});
});

describe("rine_check_inbox — Track-0 poll+ack (AC-5, AC-3)", () => {
	function inboxRoute(items: unknown[]) {
		h.route("GET", new RegExp(`^/agents/${SELF_AGENT_ID}/messages$`), () => ({
			json: {
				items,
				total: items.length,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
	}

	it("AC-5: returns decrypted messages AND marks the decryptable ones delivered", async () => {
		const env = await h.selfEncrypt({ text: "inbox message one" });
		inboxRoute([
			{
				id: MSG_UUID,
				conversation_id: CONV_UUID,
				from_agent_id: PEER_AGENT_ID,
				to_agent_id: SELF_AGENT_ID,
				sender_handle: PEER_HANDLE,
				type: "rine.v1.task_request",
				encrypted_payload: env.encrypted_payload,
				encryption_version: env.encryption_version,
				sender_signing_kid: env.sender_signing_kid,
				content_type: "application/json",
				status: "new",
				created_at: "2026-06-11T00:00:00.000Z",
			},
		]);
		let markBody: unknown;
		h.route(
			"POST",
			new RegExp(`^/agents/${SELF_AGENT_ID}/messages/mark-delivered$`),
			(req) => {
				markBody = req.body;
				return { json: { marked: 1 } };
			},
		);

		const tool = createRineCheckInboxTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { limit: 20 }, h);

		expect(out).toContain("inbox message one");
		expect(out).toContain("signature verified");
		// AC-3/I-2: ciphertext absent from the rendered list.
		expect(out).not.toContain(env.encrypted_payload);
		// AC-5: it acked the decryptable id.
		expect(markBody).toMatchObject({ message_ids: [MSG_UUID] });
		// The inbox query carried status=new.
		const inbox = h.requests.find((r) =>
			r.path.endsWith(`/agents/${SELF_AGENT_ID}/messages`),
		);
		expect(inbox?.url).toContain("status=new");
	});

	it("empty inbox → 'No new messages.' and NO mark-delivered call", async () => {
		inboxRoute([]);
		let acked = false;
		h.route(
			"POST",
			new RegExp(`^/agents/${SELF_AGENT_ID}/messages/mark-delivered$`),
			() => {
				acked = true;
				return { json: { marked: 0 } };
			},
		);
		const tool = createRineCheckInboxTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { limit: 20 }, h);
		expect(out).toBe("No new messages.");
		expect(acked).toBe(false);
	});

	it("AC-5: an ack FAILURE warns 'may reappear' but still returns the reads", async () => {
		const env = await h.selfEncrypt({ text: "still-readable" });
		inboxRoute([
			{
				id: MSG_UUID,
				conversation_id: CONV_UUID,
				from_agent_id: PEER_AGENT_ID,
				to_agent_id: SELF_AGENT_ID,
				sender_handle: PEER_HANDLE,
				type: "rine.v1.task_request",
				encrypted_payload: env.encrypted_payload,
				encryption_version: env.encryption_version,
				sender_signing_kid: env.sender_signing_kid,
				content_type: "application/json",
				status: "new",
				created_at: "2026-06-11T00:00:00.000Z",
			},
		]);
		h.route(
			"POST",
			new RegExp(`^/agents/${SELF_AGENT_ID}/messages/mark-delivered$`),
			() => ({ status: 500, json: { detail: "ack exploded" } }),
		);

		const tool = createRineCheckInboxTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { limit: 20 }, h);
		// Still returns the read message…
		expect(out).toContain("still-readable");
		// …plus the may-reappear warning.
		expect(out).toContain("may reappear");
	});
});

describe("rine_read / rine_reply (AC-1, AC-3, AC-9)", () => {
	it("read returns the decrypted single-message render (no ciphertext)", async () => {
		const env = await h.selfEncrypt({ text: "read me" });
		h.route("GET", new RegExp(`^/messages/${MSG_UUID}$`), () => ({
			json: {
				id: MSG_UUID,
				conversation_id: CONV_UUID,
				from_agent_id: PEER_AGENT_ID,
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
		const tool = createRineReadTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { messageId: MSG_UUID }, h);

		expect(out).toContain(`Message ${MSG_UUID}`);
		expect(out).toContain("body: read me");
		expect(out).toContain("(signature verified)");
		expect(out).not.toContain(env.encrypted_payload);
	});

	it("reply posts to /messages/{id}/reply and returns the reply id", async () => {
		h.route("POST", new RegExp(`^/messages/${MSG_UUID}/reply$`), () => ({
			json: {
				id: REPLY_UUID,
				conversation_id: CONV_UUID,
				from_agent_id: SELF_AGENT_ID,
				to_agent_id: PEER_AGENT_ID,
				type: "rine.v1.task_response",
				encrypted_payload: "OPAQUE",
				encryption_version: "hpke-v1",
				created_at: "2026-06-11T00:00:00.000Z",
			},
		}));
		// reply resolves the recipient (original sender) via GET /messages/{id}.
		const env = await h.selfEncrypt({ text: "original" });
		h.route("GET", new RegExp(`^/messages/${MSG_UUID}$`), () => ({
			json: {
				id: MSG_UUID,
				conversation_id: CONV_UUID,
				from_agent_id: PEER_AGENT_ID,
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

		const tool = createRineReplyTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{
				messageId: MSG_UUID,
				body: "got it",
				messageType: "rine.v1.task_response",
			},
			h,
		);
		expect(out).toBe(`Replied to ${MSG_UUID} -> ${REPLY_UUID}.`);
	});

	it("AC-9: read of an UNREADABLE envelope renders [unreadable], never ciphertext", async () => {
		// Corrupt ciphertext (a real base64url-ish blob the self-agent cannot open)
		// → the SDK returns a decrypt_error, the renderer shows [unreadable], and
		// the opaque ciphertext never reaches the string (I-2 under failure).
		const garbage =
			"AgGARBAGEgarbageGARBAGEgarbageGARBAGEgarbageGARBAGEgarbage";
		h.route("GET", new RegExp(`^/messages/${MSG_UUID}$`), () => ({
			json: {
				id: MSG_UUID,
				conversation_id: CONV_UUID,
				from_agent_id: PEER_AGENT_ID,
				to_agent_id: SELF_AGENT_ID,
				sender_handle: PEER_HANDLE,
				type: "rine.v1.task_request",
				encrypted_payload: garbage,
				encryption_version: "hpke-v1",
				sender_signing_kid: null,
				content_type: "application/json",
				created_at: "2026-06-11T00:00:00.000Z",
			},
		}));
		const tool = createRineReadTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { messageId: MSG_UUID }, h);
		expect(out).toContain("[unreadable]");
		// AC-3/I-2: even on decrypt failure the ciphertext is not surfaced.
		expect(out).not.toContain(garbage);
	});
});
