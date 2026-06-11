/**
 * Individual live-e2e legs (SPEC §16), each a focused round-trip assertion the
 * orchestrator (`e2e_live_agent.ts`) sequences. Every leg talks to a REAL rine
 * server through the SDK; the crypto (HPKE / MLS / PQ-hybrid) is the SDK's.
 *
 * I-2: every leg reads `msg.plaintext` only and asserts the ciphertext sentinel
 * never appears in a rendered/round-tripped value.
 */

import type {
	AgentHandle,
	AgentUuid,
	AsyncRineClient,
	DecryptedMessage,
	GroupHandle,
} from "@rine-network/sdk";
import { asGroupUuid, asMessageUuid } from "@rine-network/sdk";
import { groupIsMls } from "../src/format.js";

/** A tiny assert that names the failing leg. */
export function check(cond: boolean, label: string): void {
	if (!cond) throw new Error(`E2E FAIL: ${label}`);
	console.log(`  [ok] ${label}`);
}

/** Brand a runtime recipient string for the SDK send surface (validated by the SDK). */
const asHandle = (s: string): AgentHandle | GroupHandle =>
	s as AgentHandle | GroupHandle;
/** Brand a runtime agent-UUID string for the SDK group surface. */
const asAgent = (s: string): AgentUuid => s as AgentUuid;

/** Wait for the responder to ack into a 1:1 conversation; poll the inbox. */
async function awaitReply(
	client: AsyncRineClient,
	conversationId: string,
	timeoutMs = 30_000,
): Promise<DecryptedMessage | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const page = await client.inbox({ limit: 20 });
		const hit = page.items.find(
			(m) => m.conversation_id === conversationId && !m.decrypt_error,
		);
		if (hit) return hit;
		await new Promise((r) => setTimeout(r, 1500));
	}
	return undefined;
}

/**
 * Poll the driver's inbox for the responder's reply POSTED INTO the group. A
 * group reply is a fresh `mls-v1` group send (it can't thread through the 1:1
 * reply endpoint), so it lands in a NEW conversation — we match on group +
 * responder-as-sender so the driver's own post is never taken for the reply.
 */
async function awaitGroupReply(
	client: AsyncRineClient,
	groupId: string,
	fromAgentId: string,
	timeoutMs = 45_000,
): Promise<DecryptedMessage | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const page = await client.inbox({ limit: 30 });
		const hit = page.items.find(
			(m) =>
				m.group_id === groupId &&
				m.from_agent_id === fromAgentId &&
				!m.decrypt_error,
		);
		if (hit) return hit;
		await new Promise((r) => setTimeout(r, 1500));
	}
	return undefined;
}

/**
 * PQ-hybrid 1:1 round-trip (AC-8). Two SDK-created agents both carry an ML-KEM
 * key, so a 1:1 send negotiates `hpke-hybrid-v1`; assert the nonce round-trips as
 * plaintext and the wire version is the PQ-hybrid one.
 */
export async function legPq1to1(
	client: AsyncRineClient,
	responderHandle: string,
	nonce: string,
	sentinel: string,
): Promise<void> {
	const sent = await client.send(
		asHandle(responderHandle),
		{ text: `pq ping ${nonce}` },
		{ type: "rine.v1.task_request" },
	);
	check(
		sent.encryption_version === "hpke-hybrid-v1",
		`PQ-1:1 negotiated hpke-hybrid-v1 (got ${sent.encryption_version})`,
	);
	const reply = await awaitReply(client, sent.conversation_id);
	check(!!reply, "PQ-1:1 reply received");
	const text = JSON.stringify(reply?.plaintext ?? "");
	check(text.includes(nonce), "PQ-1:1 nonce round-tripped as plaintext");
	check(!text.includes(sentinel), "PQ-1:1 ciphertext sentinel absent (I-2)");
}

/**
 * MLS-group post + read round-trip (AC-6/AC-7). Create an MLS group (default
 * `enableMls:true`), invite the responder, post into it, and read the responder's
 * reply back from the group conversation.
 */
export async function legMlsGroup(
	client: AsyncRineClient,
	responderClient: AsyncRineClient,
	responderAgentId: string,
	nonce: string,
	sentinel: string,
): Promise<void> {
	// Group names must be DNS-safe (lowercase alnum, interior hyphens only) — the
	// raw nonce has hyphens, so fold them out for a clean unique-ish suffix.
	const tag = nonce.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase();
	const group = await client.groups.create(`e2e-mls-${tag}`, {
		enableMls: true,
		enrollment: "closed",
		visibility: "private",
	});
	// `mls_group_id` latches asynchronously (null at create-return); the server
	// defaults new groups to `mls_enabled=true` and the SDK runs a client-side
	// MLS init during create. `groupIsMls` is the package's own capability check;
	// the *real* MLS proof is the `mls-v1` wire version on the send below.
	check(groupIsMls(group), "MLS group latched (mls_enabled)");
	await client.groups.invite(
		asGroupUuid(group.id),
		asAgent(responderAgentId),
		{ message: "join the e2e room" },
	);
	// Group invites are two-step: the inviter pre-adds the MLS member + mints a
	// Welcome, but the invitee must `join()` to install that Welcome into its OWN
	// local MLS state before it can decrypt group posts. Without this the
	// responder would receive the SSE post but fail to decrypt → no reply.
	const joined = await responderClient.groups.join(asGroupUuid(group.id));
	check(joined.status === "joined", `responder joined MLS group (${joined.status})`);
	const sent = await client.send(
		asHandle(group.handle),
		{ text: `mls hello ${nonce}` },
		{ type: "rine.v1.task_request" },
	);
	check(
		sent.encryption_version === "mls-v1",
		`MLS group post used mls-v1 (got ${sent.encryption_version})`,
	);
	const reply = await awaitGroupReply(client, group.id, responderAgentId);
	check(!!reply, "MLS group reply received (responder posted into the group)");
	const text = JSON.stringify(reply?.plaintext ?? "");
	check(text.includes(nonce), "MLS group nonce round-tripped as plaintext");
	check(!text.includes(sentinel), "MLS group ciphertext sentinel absent (I-2)");
}

/** Read a message by id and assert no ciphertext leaks into the rendered text. */
export async function legReadNoLeak(
	client: AsyncRineClient,
	messageId: string,
	sentinel: string,
): Promise<void> {
	const msg = await client.read(asMessageUuid(messageId));
	const text = JSON.stringify(msg.plaintext ?? msg.decrypt_error ?? "");
	check(!text.includes(sentinel), "rine_read renders no ciphertext (I-2)");
}
