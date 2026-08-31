/**
 * Renderer behavior:
 *   - the plaintext-is-JSON footgun (`unwrapText`)
 *   - honest signature notes (`verifiedNote`)
 *   - the MLS-branch INVERSION (`renderGroup` → `[OK]` for MLS, capability not ceiling)
 *   - a rendered string built from a REAL self-encrypted envelope never
 *     contains the ciphertext (the genuine `encrypted_payload`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SENDER_KEY_UNAVAILABLE_CODE,
	SENDER_KEY_UNAVAILABLE_PREVIEW,
	groupIsMls,
} from "@rine-network/sdk";
import {
	renderDiscover,
	renderGroup,
	renderInbox,
	renderMessageBody,
	renderProfile,
	renderSingleMessage,
	unwrapText,
	verifiedNote,
} from "../src/format.js";
import {
	NO_CONVERSATION,
	NO_OWN_AGENTS,
} from "../src/format-groups-list.js";
import type {
	AgentProfile,
	AgentSummary,
	DecryptedMessage,
	GroupRead,
} from "../src/types.js";
import { type Harness, makeHarness } from "./harness.js";

// ---------------------------------------------------------------------------
// Pure-function fixtures
// ---------------------------------------------------------------------------

function decrypted(over: Partial<DecryptedMessage> = {}): DecryptedMessage {
	return {
		id: "m-1",
		conversation_id: "c-1",
		type: "rine.v1.task_request",
		encrypted_payload: "OPAQUE",
		encryption_version: "hpke-v1",
		metadata: {},
		created_at: "2026-06-11T00:00:00.000Z",
		verified: true,
		verification_status: "verified",
		plaintext: { text: "hello" },
		sender_handle: "alice@acme",
		decrypt_error: null,
		...over,
	} as DecryptedMessage;
}

const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const OWN_AGENT = "44444444-4444-4444-4444-444444444444";
const UNKNOWN_AGENT = "99999999-9999-4999-8999-999999999999";

// What `client.agentHandles()` answers: this org's ids indexed lowercased.
const HANDLES: ReadonlyMap<string, string> = new Map([
	[OWN_AGENT, "ops@acme"],
	["55555555-5555-4555-8555-555555555555", "billing@acme"],
]);

function group(over: Partial<GroupRead> = {}): GroupRead {
	return {
		id: "g-1",
		name: "Ops",
		handle: "#ops@acme",
		enrollment_policy: "closed",
		visibility: "private",
		mls_enabled: false,
		mls_group_id: null,
		mls_pending: false,
		conversation_id: CONVERSATION_ID,
		member_agent_ids: [OWN_AGENT],
		...over,
	} as GroupRead;
}

describe("unwrapText — plaintext-is-JSON footgun", () => {
	it("unwraps { text } to the inner string", () => {
		expect(unwrapText({ text: "hi there" })).toBe("hi there");
	});
	it("passes a raw string through unchanged", () => {
		expect(unwrapText("plain")).toBe("plain");
	});
	it("compact-stringifies an object without a text field", () => {
		expect(unwrapText({ a: 1 })).toBe('{"a":1}');
	});
	it("renders null/undefined as empty", () => {
		expect(unwrapText(null)).toBe("");
		expect(unwrapText(undefined)).toBe("");
	});
});

describe("verifiedNote — honest signatures", () => {
	it("verified → 'signature verified'", () => {
		expect(verifiedNote(decrypted({ verified: true }))).toBe(
			"signature verified",
		);
	});
	it("unverifiable → 'signature unverifiable'", () => {
		expect(
			verifiedNote(
				decrypted({ verified: false, verification_status: "unverifiable" }),
			),
		).toBe("signature unverifiable");
	});
});

describe("renderSingleMessage / renderInbox", () => {
	it("renders body from plaintext, never the envelope", () => {
		const out = renderSingleMessage(decrypted());
		expect(out).toContain("body: hello");
		expect(out).toContain("(signature verified)");
		expect(out).not.toContain("OPAQUE");
	});
	it("shows [unreadable] for a decrypt error", () => {
		const out = renderSingleMessage(
			decrypted({ plaintext: undefined, decrypt_error: "bad key" }),
		);
		expect(out).toContain("[unreadable] bad key");
	});
	it("numbered inbox / empty state", () => {
		expect(renderInbox([])).toBe("No new messages.");
		const out = renderInbox([decrypted({ id: "a" }), decrypted({ id: "b" })]);
		expect(out).toMatch(/^1\. a from alice@acme/m);
		expect(out).toMatch(/^2\. b from alice@acme/m);
	});
});

describe("explain once, then mark (renderInbox is MULTI)", () => {
	const FULL_SENTENCE =
		"rine cannot open this group message: it is sealed under sender key " +
		"11111111-1111-4111-8111-111111111111, and this agent holds no key by " +
		"that id.";
	function noKey(id: string): DecryptedMessage {
		return decrypted({
			id,
			plaintext: undefined,
			decrypt_error: FULL_SENTENCE,
			decrypt_error_code: SENDER_KEY_UNAVAILABLE_CODE,
		});
	}

	it("first unopenable row prints the full sentence, later rows the bounded marker", () => {
		const out = renderInbox([noKey("a"), noKey("b"), noKey("c")]);
		const lines = out.split("\n");
		expect(lines[0]).toContain(`[unreadable] ${FULL_SENTENCE}`);
		expect(lines[1]).toContain(`[unreadable] ${SENDER_KEY_UNAVAILABLE_PREVIEW}`);
		expect(lines[1]).not.toContain(FULL_SENTENCE);
		expect(lines[2]).toContain(`[unreadable] ${SENDER_KEY_UNAVAILABLE_PREVIEW}`);
	});

	it("a fresh renderInbox() call explains again — no module-level flag", () => {
		renderInbox([noKey("a"), noKey("b")]); // first render, spends the explanation
		const second = renderInbox([noKey("c")]);
		expect(second).toContain(FULL_SENTENCE);
	});

	it("an unrelated decrypt-error cause is untouched — no code, no tiering", () => {
		const out = renderInbox([
			decrypted({ id: "a", plaintext: undefined, decrypt_error: "bad sig" }),
			noKey("b"),
		]);
		const lines = out.split("\n");
		expect(lines[0]).toContain("[unreadable] bad sig");
		// the sender-key row is still the FIRST of its own cause, so it explains
		// in full — the unrelated cause did not spend the budget.
		expect(lines[1]).toContain(FULL_SENTENCE);
	});

	it("renderMessageBody without an explainer (SINGLE tier) always keeps the full sentence", () => {
		expect(renderMessageBody(noKey("a"))).toBe(`[unreadable] ${FULL_SENTENCE}`);
	});
});

describe("renderDiscover / renderProfile", () => {
	const summary = (over: Partial<AgentSummary> = {}): AgentSummary =>
		({
			id: "a-1",
			name: "Alice",
			handle: "alice@acme",
			verified: true,
			...over,
		}) as AgentSummary;

	it("numbered discover / empty state", () => {
		expect(renderDiscover([])).toBe("No agents matched.");
		const out = renderDiscover([summary(), summary({ handle: "bob@acme" })]);
		expect(out).toContain("1. alice@acme [verified]");
		expect(out).toContain("2. bob@acme");
	});

	it("renders a full profile", () => {
		const profile: AgentProfile = {
			id: "a-1",
			name: "Alice",
			handle: "alice@acme",
			verified: true,
			human_oversight: false,
			description: "a helpful agent",
			category: "support",
		} as AgentProfile;
		const out = renderProfile(profile);
		expect(out).toContain("Alice (alice@acme)");
		expect(out).toContain("verified: yes");
		expect(out).toContain("category: support");
	});
});

describe("renderGroup — MLS branch INVERSION", () => {
	it("MLS group renders [OK] readable/postable, not a [WARN] ceiling", () => {
		const out = renderGroup(group({ mls_group_id: "mls-abc" }));
		expect(out).toContain("[OK] MLS group");
		expect(out).toContain("readable/postable");
		expect(out).not.toContain("[WARN]");
		expect(out).not.toContain("cannot read");
	});

	it("sender-key group also renders [OK]", () => {
		const out = renderGroup(group());
		expect(out).toContain("[OK] sender-key group");
		expect(out).not.toContain("[WARN]");
	});

	it("groupIsMls reads the mls_group_id latch and nothing else", () => {
		// The latch is the only field that says the group HAS MLS state.
		expect(groupIsMls(group({ mls_group_id: "x" }))).toBe(true);
		// `mls_enabled` is an intent flag an open-enrollment group carries while
		// running on sender keys, and `mls_pending` is an init in flight —
		// neither is state, and reading them labels a sender-key group "MLS".
		expect(groupIsMls(group({ mls_enabled: true }))).toBe(false);
		expect(groupIsMls(group({ mls_pending: true }))).toBe(false);
		expect(groupIsMls(group())).toBe(false);
	});

	it("names the fourth state: created to run MLS, no ratchet tree", () => {
		// Unlatched and no init in flight, so this is field for field an open
		// group in the MLS columns — and it used to fall into the plain
		// sender-key arm, which told the agent nothing about the encryption the
		// group was created for and did not get.
		const out = renderGroup(group({ mls_enabled: true }));
		expect(out).toContain("[OK] sender-key group");
		expect(out).toContain("ratchet tree was never founded");
		// The marker stays [OK]: every claim it makes is true here. The group
		// carries traffic; only the regime is other than intended.
		expect(out).not.toContain("[WARN]");
		// Nothing here may claim the group is unusable or that the founding was
		// attempted and failed — no client can tell a died init from an init
		// that never ran, and the server does not refuse a send either way.
		expect(out).not.toMatch(/broken|frozen|failed|cannot carry|holds no keys/i);
	});

	it("says no verb on this surface founds it, because rine_group_reclaim refuses here", () => {
		// The repair clause is the SDK's, and this surface asks for the no-verb
		// spelling: naming a verb the agent would then be refused by is worse
		// than naming none. The sentence still says who CAN act.
		const out = renderGroup(group({ mls_enabled: true }));
		expect(out).toContain("No verb on this surface founds it");
		expect(out).not.toContain("rine_group_reclaim");
		expect(out).not.toContain("rine group resume-admission");
	});

	it("extends the ordinary sender-key line rather than replacing it", () => {
		// The two groups run the same cryptography and the fourth state's line
		// is the ordinary one plus the rest of the answer. If the arms ever
		// disagree about what sender keys ARE, this fails — which is the whole
		// reason the fourth arm sits in front of the plain one rather than
		// rewriting it.
		const diagnosis = (g: GroupRead) => renderGroup(g).split("\n")[1] ?? "";
		const ordinary = diagnosis(group());
		expect(ordinary).toContain("[OK] sender-key group");
		expect(diagnosis(group({ mls_enabled: true }))).toMatch(
			new RegExp(`^${ordinary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .`),
		);
	});

	it("an open-enrollment group renders as sender-key even with mls_enabled", () => {
		const out = renderGroup(
			group({ enrollment_policy: "open", mls_enabled: true }),
		);
		expect(out).toContain("[OK] sender-key group");
		expect(out).not.toContain("MLS group");
	});

	it("a group whose MLS init is in flight renders its own third state", () => {
		// Not sender-key and not yet a latched MLS group: the send path already
		// takes the MLS branch here, so either of the other two renders lies.
		const out = renderGroup(group({ mls_enabled: true, mls_pending: true }));
		expect(out).toContain("[OK] MLS group, initialising");
		expect(out).toContain("Sends from here already use MLS.");
		expect(out).not.toContain("sender-key");
		expect(out).not.toContain("[WARN]");
	});

	it("the four group states are rendered as four distinct lines", () => {
		// The regression this pins: the in-flight branch swallowing the
		// open-enrollment case, or vice versa, is invisible to a test that only
		// checks the new branch fires. The fourth state joined the set for the
		// same reason — it is the one that used to BE the sender-key render.
		const mls = renderGroup(group({ mls_group_id: "mls-abc" }));
		const inFlight = renderGroup(
			group({ mls_enabled: true, mls_pending: true }),
		);
		const neverFounded = renderGroup(group({ mls_enabled: true }));
		const senderKey = renderGroup(
			group({ enrollment_policy: "open", mls_enabled: true }),
		);
		expect(new Set([mls, inFlight, neverFounded, senderKey]).size).toBe(4);
	});
});

describe("renderGroup — the conversation pointer", () => {
	it("names the id under the same key `rine_thread` asks for", () => {
		// The whole affordance: a model reads `conversation_id: <uuid>` here and
		// fills `rine_thread`'s argument with it. Spelling the key any other way
		// puts a translation step back in exactly the place this removes one.
		expect(renderGroup(group())).toContain(
			`conversation_id: ${CONVERSATION_ID}`,
		);
	});

	it("says nothing has been said yet rather than printing a null", () => {
		const out = renderGroup(group({ conversation_id: null }));
		expect(out).toContain(NO_CONVERSATION);
		expect(out).not.toContain("null");
		expect(out).not.toContain("undefined");
	});

	it("renders the clause on every group, including the empty one", () => {
		// Omitting it on null would read to a model as a rendering fault rather
		// than as a fact, and it would have no way to tell the two apart.
		for (const g of [group(), group({ conversation_id: null })]) {
			expect(renderGroup(g)).toContain("conversation_id: ");
		}
	});
});

describe("renderGroup — which of this org's agents hold a seat", () => {
	// The `[OK]` lines above describe how the GROUP is run. None of them says
	// whether this org may act in it, and the group list this view is reached
	// from is org-scoped — so before this clause a model could read a full
	// `[OK] MLS group` report about a group holding no seat of its org's at all,
	// and learn that only from a refusal.

	it("names the seated agents by handle", () => {
		// Case 1 of the shared rule: the handle is what a model reads and what
		// every group verb takes. Its own UUID is a value it has never seen.
		expect(renderGroup(group(), HANDLES)).toContain("your agents: ops@acme");
	});

	it("prints an id this org's list cannot resolve as the id", () => {
		// Case 2 — degraded, not lost: `X-Rine-Agent` still takes the UUID.
		const out = renderGroup(
			group({ member_agent_ids: [UNKNOWN_AGENT] }),
			HANDLES,
		);
		expect(out).toContain(`your agents: ${UNKNOWN_AGENT}`);
	});

	it("prints the ids when no agent list was resolved at all", () => {
		// `client.agentHandles()` answers an empty map when `GET /agents` fails,
		// and this view must keep rendering: the group read already succeeded.
		expect(renderGroup(group())).toContain(`your agents: ${OWN_AGENT}`);
	});

	it("names every seated agent, not just the first", () => {
		const second = "55555555-5555-4555-8555-555555555555";
		const out = renderGroup(
			group({ member_agent_ids: [OWN_AGENT, second] }),
			HANDLES,
		);
		expect(out).toContain("your agents: ops@acme, billing@acme");
	});

	it("says no agent of this org is seated rather than printing an empty list", () => {
		const out = renderGroup(group({ member_agent_ids: [] }));
		expect(out).toContain(NO_OWN_AGENTS);
		expect(out).not.toContain("undefined");
	});

	it("renders the clause on every group, seated or not", () => {
		// Same reason as the conversation pointer: a clause that appears on some
		// groups and not others reads as a rendering fault, and the empty case
		// is the one a model most needs to see.
		for (const g of [group(), group({ member_agent_ids: [] })]) {
			expect(renderGroup(g)).toContain("your agents: ");
		}
	});
});

// ---------------------------------------------------------------------------
// Ciphertext-absent on a REAL self-encrypted envelope
// ---------------------------------------------------------------------------

describe("ciphertext never reaches a rendered string", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
	});
	afterEach(() => {
		h.cleanup();
	});

	it("a rendered message built from a genuine envelope omits the ciphertext", async () => {
		const env = await h.selfEncrypt({ text: "secret payload" });
		// A DecryptedMessage as the SDK would hand it back: real ciphertext on the
		// envelope, decrypted plaintext alongside.
		const msg = decrypted({
			encrypted_payload: env.encrypted_payload,
			encryption_version: env.encryption_version,
			plaintext: { text: "secret payload" },
		});
		const rendered = renderSingleMessage(msg);
		expect(rendered).toContain("secret payload");
		// The genuine ciphertext is long base64url — it must NOT appear.
		expect(rendered).not.toContain(env.encrypted_payload);
		expect(rendered).not.toContain("encrypted_payload");
	});
});
