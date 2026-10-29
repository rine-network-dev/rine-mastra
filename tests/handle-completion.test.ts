/**
 * Handle completion on the Mastra surface — a completed handle is reported,
 * not silent.
 *
 * `resolveToUuid` completes a short handle before WebFinger sees it — `peer@acme`
 * is looked up as `peer@acme.rine.network` — and answers with the resolved UUID,
 * never the handle it resolved. The three write verbs that take an agent spelling
 * (create's roster, invite, remove) therefore act on an agent the caller may not
 * have named, and every one of them answers in UUIDs, which agree with the
 * completion rather than with what was typed.
 *
 * 🔴 A LINE, not a key, and that is this surface's shape rather than a choice:
 * every tool here declares `strResult`, so there is no object to hang a field on.
 * `@rine-network/mcp` returns objects and rides the same sentence as a
 * `handle_completion` key; the CLI writes it to stderr.
 *
 * 🔴 Nothing here retypes the sentence — every expectation derives it from
 * `@rine-network/core`, whose own suite pins the bytes. Four surfaces agreeing
 * with each other and none of them agreeing with `normalizeHandle` is exactly
 * the drift a hand-typed copy would hide.
 *
 * Driven end to end through the tools' public `execute`, against the harness's
 * HTTP boundary, so the completion under test is the REAL one.
 */

import { handleCompletionNotes } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRineGroupCreateTool,
	createRineGroupInviteTool,
	createRineGroupRemoveTool,
} from "../src/groups.js";
import {
	API_URL,
	type Harness,
	PEER_AGENT_ID,
	PEER_HANDLE,
	makeHarness,
	routeGroupRow,
	runTool,
} from "./harness.js";

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});
afterEach(() => {
	h.cleanup();
});

const GROUP_ID = "77777777-7777-4777-8777-777777777777";
const GROUP_HANDLE = "#ops@acme.rine.network";

/** The org half without its domain — what a model types when it half-remembers. */
const TYPED = "peer@acme";
/** The sentence the caller is owed for it, composed in `@rine-network/core`. */
const NOTICE = handleCompletionNotes([TYPED]);

function groupJson(over: Record<string, unknown> = {}) {
	return {
		id: GROUP_ID,
		name: "Ops",
		handle: GROUP_HANDLE,
		enrollment_policy: "closed",
		visibility: "private",
		created_at: "2026-06-11T00:00:00.000Z",
		mls_enabled: false,
		mls_group_id: null,
		mls_pending: false,
		...over,
	};
}

/**
 * WebFinger answers the same UUID whatever spelling is asked for.
 *
 * 🔴 Deliberate: what the notice reports is the SPELLING the caller typed, and
 * it must not be derivable from the lookup's answer. A route that echoed the
 * request's `resource` back would let a wrong implementation pass by reading
 * its own input.
 */
function routeWebFinger(): void {
	h.route("GET", /^\/\.well-known\/webfinger$/, () => ({
		json: {
			subject: `acct:${PEER_HANDLE}`,
			aliases: [`${API_URL}/agents/${PEER_AGENT_ID}`],
		},
	}));
}

function routeOrgGroups(): void {
	h.route("GET", /^\/groups$/, () => ({
		json: {
			items: [groupJson()],
			total: 1,
			next_cursor: null,
			prev_cursor: null,
		},
	}));
}

describe("rine_group_create — a rewritten roster spelling is named", () => {
	// A founding roster is where a silent completion does the most damage and
	// hides the best: one rewritten name among twenty seats itself, and every
	// later read of the group agrees with the seat rather than with what was
	// typed.
	it("leads the answer with the notice, and still reports the roster", async () => {
		routeWebFinger();
		h.route("POST", /^\/groups$/, () => ({
			json: {
				group: groupJson(),
				roster: {
					invited: 1,
					skipped: 0,
					entries: [
						{ agent_id: PEER_AGENT_ID, status: "invited", reason: null },
					],
				},
			},
		}));
		h.route("POST", /^\/messages$/, () => ({ json: { id: "m1" } }));

		const out = await runTool(
			createRineGroupCreateTool({ configDir: h.configDir, apiUrl: API_URL }),
			{
				name: "Ops",
				enrollment: "closed",
				visibility: "private",
				enableMls: false,
				members: [TYPED],
			},
			h,
		);

		// 🔴 It LEADS rather than trails: a model reads the head of a tool result
		// and acts on it, and a caveat about which agent was actually admitted is
		// worth nothing underneath the report of admitting them.
		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		// The notice is a caveat about WHICH agents were admitted, never a
		// substitute for the admission report.
		expect(out).toContain("1 of 1 reached; 1 new invitation to accept.");
		expect(out).toContain("nobody is a member until they join");
	});

	// The create answer has two shapes — with a roster and without one — and the
	// notice is owed on both. The rosterless arm returns from a different
	// statement, which is where a per-branch renderer loses it.
	it("still names it when the server answered no roster", async () => {
		routeWebFinger();
		h.route("POST", /^\/groups$/, () => ({ json: groupJson() }));

		const out = await runTool(
			createRineGroupCreateTool({ configDir: h.configDir, apiUrl: API_URL }),
			{
				name: "Ops",
				enrollment: "closed",
				visibility: "private",
				enableMls: false,
				members: [TYPED],
			},
			h,
		);

		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		expect(out).toContain(`Created group ${GROUP_HANDLE}`);
	});

	it("says nothing when every rostered spelling was already whole", async () => {
		routeWebFinger();
		h.route("POST", /^\/groups$/, () => ({ json: groupJson() }));

		const out = await runTool(
			createRineGroupCreateTool({ configDir: h.configDir, apiUrl: API_URL }),
			{
				name: "Ops",
				enrollment: "closed",
				visibility: "private",
				enableMls: false,
				members: [PEER_HANDLE],
			},
			h,
		);

		expect(out).not.toContain("was completed to");
		expect(out.startsWith(`Created group ${GROUP_HANDLE}`)).toBe(true);
	});
});

describe("rine_group_invite — a rewritten invitee spelling is named", () => {
	beforeEach(() => {
		routeWebFinger();
		routeOrgGroups();
		routeGroupRow(h, groupJson());
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/invite$`), () => ({
			json: { status: "invited", request_id: null },
		}));
		h.route("POST", /^\/groups\/.+\/mls/, () => ({ json: {} }));
		// The best-effort `rine.v1.group_invite` notice. Unrouted it still passes
		// — the invite is not conditional on it — but it warns on stderr, and a
		// suite that prints a shipped warning on every green run teaches the next
		// reader to skim past one.
		h.route("POST", /^\/messages$/, () => ({ json: { id: "m1" } }));
	});

	// 🔴 This arm is why the notice is owed at all here: `renderSingularInvite`
	// echoes the caller's own spelling, so without it the answer agrees with what
	// was typed while the invitation went to the completed handle.
	it("names it beside the sentence that echoes the caller's spelling", async () => {
		const out = await runTool(
			createRineGroupInviteTool({ configDir: h.configDir, apiUrl: API_URL }),
			{ group: GROUP_HANDLE, agentToInvite: TYPED },
			h,
		);

		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		expect(out).toContain(`Invited ${TYPED} to ${GROUP_HANDLE}.`);
	});

	it("names only the batch spellings that were rewritten", async () => {
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/invite$`), () => ({
			json: {
				invited: 2,
				skipped: 0,
				entries: [
					{ agent_id: PEER_AGENT_ID, status: "invited", reason: null },
				],
			},
		}));

		const out = await runTool(
			createRineGroupInviteTool({ configDir: h.configDir, apiUrl: API_URL }),
			{ group: GROUP_HANDLE, agentsToInvite: [TYPED, PEER_HANDLE] },
			h,
		);

		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		// One sentence, not two: the whole spelling contributes nothing.
		expect(out.split("was completed to")).toHaveLength(2);
		expect(out).toContain(`Invited into ${GROUP_HANDLE}:`);
	});

	it("says nothing when the invitee's spelling was already whole", async () => {
		const out = await runTool(
			createRineGroupInviteTool({ configDir: h.configDir, apiUrl: API_URL }),
			{ group: GROUP_HANDLE, agentToInvite: PEER_HANDLE },
			h,
		);

		expect(out).not.toContain("was completed to");
		expect(out.startsWith("Invited ")).toBe(true);
	});
});

describe("rine_group_remove — a rewritten target spelling is named", () => {
	beforeEach(() => {
		routeWebFinger();
		routeOrgGroups();
		routeGroupRow(h, groupJson());
		h.route(
			"DELETE",
			new RegExp(`^/groups/${GROUP_ID}/members/${PEER_AGENT_ID}$`),
			() => ({ status: 204 }),
		);
	});

	// 🔴 The verb where a silent completion is least recoverable: a removal takes
	// nothing back. The SDK's sentence names the UUID it acted on, so the notice
	// is the only thing tying that UUID to the spelling the caller typed.
	it("names it above the SDK's own eviction sentence", async () => {
		const out = await runTool(
			createRineGroupRemoveTool({ configDir: h.configDir, apiUrl: API_URL }),
			{ group: GROUP_HANDLE, agentId: TYPED },
			h,
		);

		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		// The accurate sentence is still the SDK's and is not replaced by the
		// caveat — composing a second one here is how this surface once shipped a
		// removal sentence that was false for open groups.
		expect(out).toContain(`Removed ${PEER_AGENT_ID} from group`);
	});

	it("says nothing when the target's spelling was already whole", async () => {
		const out = await runTool(
			createRineGroupRemoveTool({ configDir: h.configDir, apiUrl: API_URL }),
			{ group: GROUP_HANDLE, agentId: PEER_HANDLE },
			h,
		);

		expect(out).not.toContain("was completed to");
		expect(out.startsWith("Removed ")).toBe(true);
	});
});
