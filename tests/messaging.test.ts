/**
 * The 5 messaging tools, driven through their public Mastra `execute` interface
 * against the real SDK + real crypto + a mock HTTP boundary.
 *
 * Covers: happy strings against observable HTTP; error paths that resolve a
 * readable string rather than reject; ciphertext absent on every messaging
 * path; the group route and the 1:1-only refusal without an HTTP call;
 * poll+ack incl. the ack-failure "may reappear" warning; and verified vs
 * unverifiable signature notes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRineInboxTool,
	createRineReadTool,
	createRineReplyTool,
	createRineSendAndWaitTool,
	createRineSendTool,
	createRineThreadTool,
} from "../src/messaging.js";
import {
	API_URL,
	type Harness,
	PEER_AGENT_ID,
	PEER_HANDLE,
	SELF_AGENT_ID,
	SENTINEL_CIPHERTEXT,
	makeHarness,
	routeGroupRow,
	routeNoGroupOfThatId,
	runTool,
} from "./harness.js";

let h: Harness;

beforeEach(() => {
	h = makeHarness();
	// `PEER_AGENT_ID` names an agent, and a UUID recipient is probed
	// against the group namespace before the agent one. Saying so once here is
	// the fixture's own truth; a test that means this id to BE a group
	// overrides the route, newest wins.
	routeNoGroupOfThatId(h, PEER_AGENT_ID);
});
afterEach(() => {
	h.cleanup();
});

const MSG_UUID = "33333333-3333-4333-8333-333333333333";
const CONV_UUID = "44444444-4444-4444-8444-444444444444";
const REPLY_UUID = "66666666-6666-4666-8666-666666666666";
const GROUP_UUID = "55555555-5555-4555-8555-555555555555";
const GROUP_HANDLE = "#logistics@acme";

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

describe("rine_send (incl. the group route)", () => {
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
		// The observable HTTP boundary shows the POST.
		const posts = h.requests.filter(
			(r) => r.method === "POST" && r.path === "/messages",
		);
		expect(posts).toHaveLength(1);
	});

	it("the wire body is ciphertext; the sentinel plaintext never appears in it", async () => {
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

	it("a `#`-group target routes through the SAME client.send (group path)", async () => {
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

	it("a 404 from the wire resolves to a formatError string (never rejects)", async () => {
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

describe("rine_send_and_wait (1:1-only)", () => {
	it("returns the decrypted reply + honest signature note", async () => {
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
		// The real ciphertext never appears in the returned string.
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

	it("a `#`-group target returns the 1:1-only string WITHOUT any HTTP call", async () => {
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
		// Derived from the tools' OWN ids — BOTH of them. The refusal has to name
		// verbs this surface registers, because a model calls back the verb it is
		// told, and the second verb is the one it is being sent to. Retyping
		// `rine_send` here left that half agreeing with a literal instead of with
		// the registry.
		expect(out).toBe(
			`${tool.id} is 1:1 only; use ${createRineSendTool().id} for groups.`,
		);
		// The group guard is a synchronous throw before any request.
		expect(h.requests.length).toBe(before);
	});
});

describe("rine_inbox — Track-0 poll+ack", () => {
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

	it("returns decrypted messages AND marks the decryptable ones delivered", async () => {
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

		const tool = createRineInboxTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { limit: 20 }, h);

		expect(out).toContain("inbox message one");
		expect(out).toContain("signature verified");
		// Ciphertext absent from the rendered list.
		expect(out).not.toContain(env.encrypted_payload);
		// It acked the decryptable id.
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
		const tool = createRineInboxTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { limit: 20 }, h);
		expect(out).toBe("No new messages.");
		expect(acked).toBe(false);
	});

	/** One decryptable inbox row, sealed to this agent. */
	async function selfMessage(id: string, text: string) {
		const env = await h.selfEncrypt({ text });
		return {
			id,
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
		};
	}

	it("status 'all' sends NO status parameter on the wire", async () => {
		inboxRoute([await selfMessage(MSG_UUID, "anything at all")]);
		h.route(
			"POST",
			new RegExp(`^/agents/${SELF_AGENT_ID}/messages/mark-delivered$`),
			() => ({ json: { marked: 0 } }),
		);
		const tool = createRineInboxTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		await runTool(tool, { status: "all", limit: 20 }, h);

		// `all` is a TOOL-layer value. The server's filter is a three-value
		// literal and "everything" is the ABSENCE of the parameter, so forwarding
		// the word would 422 at the network on every call.
		const inbox = h.requests.find((r) =>
			r.path.endsWith(`/agents/${SELF_AGENT_ID}/messages`),
		);
		expect(inbox?.url).not.toContain("status=");
	});

	it("status 'read' issues no mark-delivered write", async () => {
		inboxRoute([await selfMessage(MSG_UUID, "already acknowledged")]);
		let acked = false;
		h.route(
			"POST",
			new RegExp(`^/agents/${SELF_AGENT_ID}/messages/mark-delivered$`),
			() => {
				acked = true;
				return { json: { marked: 1 } };
			},
		);
		const tool = createRineInboxTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		const out = await runTool(tool, { status: "read", limit: 20 }, h);

		// Every filter but `new` is a re-read of mail this agent already
		// acknowledged; acking there would consume messages the caller asked
		// only to see.
		expect(out).toContain("already acknowledged");
		expect(acked).toBe(false);
	});

	it("raw input with no status still polls the new mail and acks it", async () => {
		inboxRoute([await selfMessage(MSG_UUID, "unacknowledged mail")]);
		let markBody: unknown;
		h.route(
			"POST",
			new RegExp(`^/agents/${SELF_AGENT_ID}/messages/mark-delivered$`),
			(req) => {
				markBody = req.body;
				return { json: { marked: 1 } };
			},
		);
		const tool = createRineInboxTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		// `execute` called with input Mastra never validated, so the schema's
		// default never applied: without the in-body `?? "new"` this silently
		// turns the poll+ack primitive into an unfiltered read that acks nothing.
		await runTool(tool, {} as never, h);

		const inbox = h.requests.find((r) =>
			r.path.endsWith(`/agents/${SELF_AGENT_ID}/messages`),
		);
		expect(inbox?.url).toContain("status=new");
		expect(markBody).toMatchObject({ message_ids: [MSG_UUID] });
	});

	it("an ack FAILURE warns 'may reappear' but still returns the reads", async () => {
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

		const tool = createRineInboxTool({
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

describe("rine_read / rine_reply", () => {
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

	it("reply-in-place keeps the inbound conversation (reply endpoint), default type task_response", async () => {
		let replyBody: Record<string, unknown> | undefined;
		h.route("POST", new RegExp(`^/messages/${MSG_UUID}/reply$`), (req) => {
			replyBody = req.body as Record<string, unknown>;
			return {
				json: {
					id: REPLY_UUID,
					// Server preserves the inbound conversation on the reply endpoint.
					conversation_id: CONV_UUID,
					from_agent_id: SELF_AGENT_ID,
					to_agent_id: PEER_AGENT_ID,
					type: "rine.v1.task_response",
					encrypted_payload: "OPAQUE",
					encryption_version: "hpke-v1",
					created_at: "2026-06-11T00:00:00.000Z",
				},
			};
		});
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
		// No messageType supplied → schema default applies (type-preserving).
		const out = await runTool(tool, { messageId: MSG_UUID, body: "got it" }, h);
		expect(out).toBe(`Replied to ${MSG_UUID} -> ${REPLY_UUID}.`);
		// Behavioral: it hit the in-place reply endpoint for the inbound id, NOT
		// a forking POST /messages.
		const replyPost = h.requests.find(
			(r) => r.method === "POST" && r.path === `/messages/${MSG_UUID}/reply`,
		);
		expect(replyPost).toBeDefined();
		expect(
			h.requests.filter((r) => r.method === "POST" && r.path === "/messages"),
		).toHaveLength(0);
		// Type is the reply default (task_response) — NOT forced to task_request,
		// so a peer Eve's loop guard still treats it as terminal.
		expect(replyBody?.type).toBe("rine.v1.task_response");
	});

	it("tool descriptions steer follow-ups to rine_reply (same thread) over rine_send (new conversation)", () => {
		const reply = createRineReplyTool();
		const send = createRineSendTool();
		expect(reply.description?.toLowerCase()).toContain("same conversation");
		expect(send.description?.toLowerCase()).toContain("new conversation");
	});

	it("rine_thread renders the both-sided transcript role-tagged (pull-only)", async () => {
		// A received turn from the peer, sealed to us (real crypto via the harness).
		const recv = await h.selfEncrypt({ text: "peer turn one" });
		h.route("GET", new RegExp(`^/conversations/${CONV_UUID}/messages$`), () => ({
			json: {
				messages: [
					{
						id: MSG_UUID,
						conversation_id: CONV_UUID,
						direction: "received",
						sender_handle: PEER_HANDLE,
						from_agent_id: PEER_AGENT_ID,
						to_agent_id: SELF_AGENT_ID,
						type: "rine.v1.task_request",
						encrypted_payload: recv.encrypted_payload,
						encryption_version: recv.encryption_version,
						sender_signing_kid: recv.sender_signing_kid,
						content_type: "application/json",
						created_at: "2026-06-11T00:00:00.000Z",
					},
				],
				truncated: false,
			},
		}));

		const tool = createRineThreadTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { conversationId: CONV_UUID }, h);

		expect(out).toContain(`[received] ${PEER_HANDLE}: peer turn one`);
		// Ciphertext never surfaces in the rendered transcript.
		expect(out).not.toContain(recv.encrypted_payload);
	});

	// Every other group verb on this surface takes the group; the one that
	// read what the group SAID took a conversation UUID, so a model holding a
	// group had nowhere to put it. These pin that it now has one, and that the
	// conversation reference it replaces nothing of still works.
	it("rine_thread reads a group named by its handle", async () => {
		const post = await h.selfEncrypt({ text: "the delivery is booked" });
		// A whole row, not the two columns this assertion reads: the group
		// resolver hands its answer back through the SDK's own `GroupReadSchema`,
		// the same parse `groups.get` has always made of the same body, so a row
		// missing a column the server always sends describes a server that does
		// not exist.
		h.route("GET", /^\/groups$/, () => ({
			json: {
				items: [
					{
						id: GROUP_UUID,
						name: "logistics",
						handle: GROUP_HANDLE,
						created_at: "2026-06-11T00:00:00.000Z",
					},
				],
			},
		}));
		h.route("GET", new RegExp(`^/groups/${GROUP_UUID}/messages$`), () => ({
			json: {
				messages: [
					{
						id: MSG_UUID,
						conversation_id: CONV_UUID,
						group_id: GROUP_UUID,
						direction: "received",
						sender_handle: PEER_HANDLE,
						from_agent_id: PEER_AGENT_ID,
						type: "rine.v1.task_request",
						encrypted_payload: post.encrypted_payload,
						encryption_version: post.encryption_version,
						sender_signing_kid: post.sender_signing_kid,
						content_type: "application/json",
						created_at: "2026-06-11T00:00:00.000Z",
					},
				],
				truncated: false,
			},
		}));

		const tool = createRineThreadTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: GROUP_HANDLE }, h);

		expect(out).toContain(`[received] ${PEER_HANDLE}: the delivery is booked`);
		expect(h.requests.map((r) => r.path)).toContain(
			`/groups/${GROUP_UUID}/messages`,
		);
	});

	// A UUID is not a spelling of the handle above — it names the group by
	// identity, so the resolve reads it from the group's OWN indexed row and
	// never touches `GET /groups`. Nothing else in this file addresses a group
	// that way, so before this the transcript read's commonest reference on an
	// agent surface (the id `rine_groups` prints beside every row) was covered
	// by no test at all.
	it("rine_thread reads a group named by its UUID, off the group's own row", async () => {
		const post = await h.selfEncrypt({ text: "the delivery is booked" });
		routeGroupRow(h, {
			id: GROUP_UUID,
			name: "logistics",
			handle: GROUP_HANDLE,
			created_at: "2026-06-11T00:00:00.000Z",
		});
		h.route("GET", new RegExp(`^/groups/${GROUP_UUID}/messages$`), () => ({
			json: {
				messages: [
					{
						id: MSG_UUID,
						conversation_id: CONV_UUID,
						group_id: GROUP_UUID,
						direction: "received",
						sender_handle: PEER_HANDLE,
						from_agent_id: PEER_AGENT_ID,
						type: "rine.v1.task_request",
						encrypted_payload: post.encrypted_payload,
						encryption_version: post.encryption_version,
						sender_signing_kid: post.sender_signing_kid,
						content_type: "application/json",
						created_at: "2026-06-11T00:00:00.000Z",
					},
				],
				truncated: false,
			},
		}));

		const tool = createRineThreadTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: GROUP_UUID }, h);

		expect(out).toContain(`[received] ${PEER_HANDLE}: the delivery is booked`);
		// 🔴 The org's unpaginated list is not read at all: an id costs the
		// indexed row and nothing else, and the list is paid only to compose a
		// refusal. A test that only asserted the transcript came back would pass
		// just as well on the O(groups) read this resolve removed.
		expect(h.requests.map((r) => r.path)).not.toContain("/groups");
		expect(h.requests.map((r) => r.path)).toContain(`/groups/${GROUP_UUID}`);
	});

	// The measured failure: a model put the group's NAME in the conversation
	// slot and the server — which types that path parameter `uuid.UUID` — answered
	// a framework 422 with no next step in it. All three mistakes are decided
	// offline now, so a caller that named the wrong thing spends nothing.
	it.each([
		[
			"both references",
			{ group: GROUP_HANDLE, conversationId: CONV_UUID },
			"Name exactly one of group",
		],
		["neither reference", {}, "Name exactly one of group"],
		[
			"a conversation reference that is not a UUID",
			{ conversationId: "quarterly planning group" },
			"To read a group, name the group instead",
		],
	])("rine_thread refuses %s without spending a request", async (
		_case,
		input,
		expected,
	) => {
		const tool = createRineThreadTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		const out = await runTool(tool, input, h);

		expect(out).toContain(expected);
		expect(h.requests).toHaveLength(0);
	});

	it("read of an UNREADABLE envelope renders [unreadable], never ciphertext", async () => {
		// Corrupt ciphertext (a real base64url-ish blob the self-agent cannot open)
		// → the SDK returns a decrypt_error, the renderer shows [unreadable], and
		// the opaque ciphertext never reaches the string, even under failure.
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
		// Even on decrypt failure the ciphertext is not surfaced.
		expect(out).not.toContain(garbage);
	});
});
