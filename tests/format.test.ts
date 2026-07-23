/**
 * Renderer behavior:
 *   - the plaintext-is-JSON footgun (`unwrapText`)
 *   - honest signature notes (`verifiedNote`)
 *   - the MLS-branch INVERSION (`renderGroup` → `[OK]` for MLS, capability not ceiling)
 *   - I-2: a rendered string built from a REAL self-encrypted envelope never
 *     contains the ciphertext (the genuine `encrypted_payload`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	groupIsMls,
	renderDiscover,
	renderGroup,
	renderInbox,
	renderProfile,
	renderSingleMessage,
	unwrapText,
	verifiedNote,
} from "../src/format.js";
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
		const out = renderGroup(
			group({ mls_enabled: true, mls_group_id: "mls-abc" }),
		);
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

	it("groupIsMls self-diagnoses via mls_group_id (not the EncryptionVersion enum)", () => {
		expect(groupIsMls(group({ mls_group_id: "x" }))).toBe(true);
		expect(groupIsMls(group({ mls_enabled: true }))).toBe(true);
		expect(groupIsMls(group({ mls_pending: true }))).toBe(true);
		expect(groupIsMls(group())).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// I-2: ciphertext-absent on a REAL self-encrypted envelope
// ---------------------------------------------------------------------------

describe("I-2 — ciphertext never reaches a rendered string", () => {
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
