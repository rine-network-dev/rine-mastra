/**
 * Error → string mapping. Each SDK error class maps to its
 * documented readable string; `formatError` always RESOLVES a string (it never
 * throws), so a tool's `execute` can return it directly without ever rejecting.
 * Ordering matters — the subclasses all extend `RineApiError`, so the table must
 * resolve most-specific-first.
 */

import type { GroupRead } from "@rine-network/core";
import { matchGroupByName, recipientGroupForBareName } from "@rine-network/core";
import {
	APIConnectionError,
	AuthenticationError,
	AuthorizationError,
	ConfigError,
	ConflictError,
	CryptoError,
	InternalServerError,
	NotFoundError,
	RateLimitError,
	RineApiError,
	RineTimeoutError,
	SchemaValidationError,
	ServiceUnavailableError,
	ValidationError,
} from "@rine-network/sdk";
import { describe, expect, it } from "vitest";
import {
	GROUP_ON_WAIT_MESSAGE,
	formatError,
	isGroupUnsupportedOnWait,
} from "../src/errors.js";
import {
	createRineSendAndWaitTool,
	createRineSendTool,
} from "../src/messaging.js";

/** One group of the caller's org, so a miss has a roster to hand back. */
const PLANNING = {
	id: "g-1",
	name: "Planning",
	handle: "#planning@acme.rine.network",
	description: null,
	enrollment_policy: "closed",
	visibility: "private",
	isolated: false,
	vote_duration_hours: 48,
	member_count: 1,
	created_at: "2026-01-01T00:00:00Z",
	conversation_id: null,
} as GroupRead;

describe("formatError — error table", () => {
	it("AuthenticationError → onboard guidance", () => {
		const out = formatError(new AuthenticationError("nope"));
		expect(out).toContain("Rine auth failed");
		expect(out).toContain("npx @rine-network/mastra onboard");
	});

	it("AuthorizationError → not authorized + detail", () => {
		expect(formatError(new AuthorizationError("you cannot"))).toBe(
			"Not authorized: you cannot.",
		);
	});

	it("NotFoundError → not found + discover hint", () => {
		const out = formatError(new NotFoundError("no agent xyz"));
		expect(out).toBe(
			"Not found: no agent xyz. Try rine_discover to find the right handle.",
		);
	});

	// `rine_discover` searches AGENTS, so it can never resolve a group handle.
	//
	// 🔴 Three producers reach `formatError` and only ONE of them is a
	// `NotFoundError`. What this replaced was an `it.each` that fed
	// `new NotFoundError("Group not found: <handle>")` in by hand — an input the
	// product cannot make (the SDK throws a plain `Error` there) — so the case
	// that mattered was asserted on a fabrication while the shipped shape was
	// tested by nothing at all. Each of the three is now driven the way it is
	// really produced.
	it("a server group 404 → the group directory, not the agent one", () => {
		expect(formatError(new NotFoundError("Group not found"))).toBe(
			"Not found: Group not found. Try rine_groups to find the right group handle, or rine_discover_groups to search the public directory.",
		);
	});

	// `rine-ts-sdk`'s `resolveGroup` runs before EVERY group send and throws a
	// PLAIN `Error`, so this arm — not the `NotFoundError` one — is what a
	// mistyped handle on `rine_send` actually lands in.
	it("the SDK's handle-resolution 404 is a plain Error and still gets the group remedy", () => {
		expect(
			formatError(new Error("Group not found: #ops@acme.rine.network")),
		).toBe(
			"Not found: Group not found: #ops@acme.rine.network. Try rine_groups to find the right group handle, or rine_discover_groups to search the public directory.",
		);
	});

	// 🔴 What this replaced asserted a THIRD producer — this package's own
	// `noGroupAmongYours`, built from `groups.list()` and a local match. Removing
	// that local match took the ladder and the sentence with it, so the case is
	// gone rather than rewritten: keeping it would have pinned a message no code
	// path can now produce. Its successor is `resolves an unknown group through
	// the SDK's own refusal` (`groups.test.ts`), driven through a real tool over
	// real HTTP.
	//
	// This is the arm the removal could have broken instead: an AMBIGUOUS bare
	// name is not a not-found, it already names the groups it is torn between,
	// and it must reach the caller verbatim, with no verb appended. Driven by the
	// real producer, never by a hand-typed message.
	it("an ambiguous bare name prints verbatim with no verb appended", () => {
		const invoices = {
			...PLANNING,
			id: "g-2",
			name: "invoices",
			handle: "#invoices@acme.rine.network",
		};
		const other = {
			...PLANNING,
			id: "g-3",
			name: "invoices",
			handle: "#invoices@other.rine.network",
		};
		let out = "";
		try {
			matchGroupByName([invoices, other], "invoices");
		} catch (err) {
			out = formatError(err);
		}
		expect(out).toContain("is ambiguous");
		expect(out).not.toContain("Not found:");
		expect(out).not.toContain("rine_groups");
		expect(out).not.toContain("rine_discover_groups");
	});

	// The ORDER is the substance: `rine_discover_groups` reaches only
	// `visibility == "public"` groups, so a member of a PRIVATE group who
	// mistypes the handle needs `rine_groups` — which lists every group the
	// credential can see — named first.
	it("names rine_groups before rine_discover_groups", () => {
		const out = formatError(new NotFoundError("Group not found"));
		expect(out).toContain("rine_groups");
		expect(out).toContain("rine_discover_groups");
		expect(out.indexOf("rine_groups")).toBeLessThan(
			out.indexOf("rine_discover_groups"),
		);
	});

	// Driven by the real producer, never by a hand-typed detail: `client.send`
	// and every group verb resolve a bare reference through `matchGroupByName`,
	// which refuses with the org's own roster inline. A rosterless fixture is
	// what let this arm ship telling a model to run the verb whose output it is
	// printing — the loop this surface removed, inverted.
	it("a group 404 carrying the roster names only the public directory", () => {
		expect(() => matchGroupByName([PLANNING], "invoices")).toThrow();
		let out = "";
		try {
			matchGroupByName([PLANNING], "invoices");
		} catch (err) {
			out = formatError(err);
		}
		expect(out).toBe(
			"Not found: Group not found: invoices. Name one of these groups:\n" +
				"  - #planning@acme.rine.network (Planning)\n" +
				"Try rine_discover_groups to search the public directory.",
		);
		expect(out).not.toContain("rine_groups to find");
	});

	// The empty arm has no roster to read, and `rine_groups` would answer it
	// with an empty list, so it is dropped there too. One line, so the remedy
	// joins with a space rather than a newline.
	// 🔴 The BARE-name miss stopped opening with a group verdict,
	// and the REMEDY must not follow it out of the group half of the directory.
	// `isGroupNotFound` matches the second lead by CONTAINMENT, because its
	// sentence opens with the caller's own spelling — narrow it back to
	// `startsWith` and this refusal drops into `formatError`'s catch-all, which
	// names `rine_discover`: the AGENT directory, which cannot resolve a group
	// handle. That is the regression this test exists to fail on.
	it("a bare name that answers to nothing still names the group directory", () => {
		let out = "";
		try {
			recipientGroupForBareName([PLANNING], "kofi");
		} catch (err) {
			out = formatError(err);
		}
		expect(out).toContain("'kofi' names neither an agent nor a group you can reach.");
		expect(out.endsWith("Try rine_discover_groups to search the public directory.")).toBe(
			true,
		);
		expect(out).not.toContain("Try rine_discover to");
	});

	it("a group 404 in an org with no groups names only the public directory", () => {
		let out = "";
		try {
			matchGroupByName([], "invoices");
		} catch (err) {
			out = formatError(err);
		}
		expect(out).toBe(
			"Not found: Group not found: invoices. This org is in no groups yet. Try rine_discover_groups to search the public directory.",
		);
		expect(out).not.toContain("rine_groups to find");
	});

	it("RateLimitError → retry-after seconds", () => {
		expect(formatError(new RateLimitError("slow down", 12))).toBe(
			"Rate-limited; retry after 12s.",
		);
	});

	it("RateLimitError without retryAfter → graceful fallback", () => {
		expect(formatError(new RateLimitError("slow down"))).toBe(
			"Rate-limited; retry after a fews.",
		);
	});

	it("ValidationError → invalid input", () => {
		expect(formatError(new ValidationError("bad field"))).toBe(
			"Invalid input: bad field.",
		);
	});

	it("SchemaValidationError → invalid input (both mapped)", () => {
		expect(formatError(new SchemaValidationError("schema mismatch"))).toBe(
			"Invalid input: schema mismatch.",
		);
	});

	it("RineTimeoutError → timed out", () => {
		expect(formatError(new RineTimeoutError("op timeout"))).toBe(
			"Request timed out; try again or raise the timeout.",
		);
	});

	it("ConfigError → raw message", () => {
		expect(formatError(new ConfigError("no poll url configured"))).toBe(
			"no poll url configured",
		);
	});

	it("CryptoError → encryption error + keys hint", () => {
		expect(formatError(new CryptoError("seal failed"))).toBe(
			"Encryption error: seal failed (check your agent keys are on disk).",
		);
	});

	it("APIConnectionError → could not reach", () => {
		expect(formatError(new APIConnectionError("ECONNREFUSED"))).toBe(
			"Could not reach rine: ECONNREFUSED.",
		);
	});

	it("ConflictError (no specific branch) → catch-all status:detail", () => {
		expect(formatError(new ConflictError("dup name"))).toBe("409: dup name");
	});

	it("InternalServerError → catch-all status:detail", () => {
		expect(formatError(new InternalServerError("boom"))).toBe("500: boom");
	});

	it("ServiceUnavailableError → catch-all status:detail", () => {
		expect(formatError(new ServiceUnavailableError("maint"))).toBe(
			"503: maint",
		);
	});

	it("bare RineApiError → status:detail", () => {
		expect(formatError(new RineApiError(418, "teapot"))).toBe("418: teapot");
	});

	it("plain Error → message fallthrough", () => {
		expect(formatError(new Error("unexpected"))).toBe("unexpected");
	});

	it("non-Error value → stringified", () => {
		expect(formatError("just a string")).toBe("just a string");
		expect(formatError(null)).toBe("unknown error");
	});

	it("never throws for any mapped error (always resolves a string)", () => {
		const cases: unknown[] = [
			new AuthenticationError(),
			new NotFoundError(),
			new RateLimitError("x"),
			new ValidationError(),
			new CryptoError("x"),
			new ConfigError("x"),
			new RineApiError(500, "x"),
			new Error("x"),
			undefined,
			42,
		];
		for (const c of cases) {
			expect(typeof formatError(c)).toBe("string");
		}
	});
});

describe("isGroupUnsupportedOnWait — substring catch (not a typed error)", () => {
	it("matches the sendAndWait group-handle Error message", () => {
		const err = new Error(
			"sendAndWait() does not support group handles — the server's /messages/sync endpoint is 1:1 only.",
		);
		expect(isGroupUnsupportedOnWait(err)).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isGroupUnsupportedOnWait(new Error("something else"))).toBe(false);
		expect(isGroupUnsupportedOnWait(new NotFoundError("x"))).toBe(false);
		expect(isGroupUnsupportedOnWait("not an error")).toBe(false);
	});

	it("names both verbs by the ids this surface actually registers", () => {
		// 🔴 Derived, not retyped. Both ids come off the tool factories, so
		// renaming either verb turns this red instead of shipping a refusal that
		// sends a model to a tool that no longer exists. Retyping the sentence
		// here made this assertion agree with a stale constant — the exact drift
		// a cross-package byte pin structurally cannot see, because it compares
		// the copies to each other and none of them to the registry.
		const wait = createRineSendAndWaitTool();
		const send = createRineSendTool();
		expect(GROUP_ON_WAIT_MESSAGE).toBe(
			`${wait.id} is 1:1 only; use ${send.id} for groups.`,
		);
	});
});
