/**
 * Visibility is stated rather than guessed on the Mastra surface, and
 * admission is plural.
 *
 * These assert the observable boundary — the schema a model reads before it
 * calls, and the request body that leaves the process — rather than the shape
 * of the code that produces them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRineGroupCreateTool,
	createRineGroupInviteTool,
} from "../src/groups.js";
import {
	VISIBILITY_REQUIRED,
	groupCreateInput,
	groupInviteInput,
} from "../src/schemas-groups.js";
import {
	API_URL,
	type Harness,
	PEER_AGENT_ID,
	PEER_HANDLE,
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

const GROUP_ID = "77777777-7777-4777-8777-777777777777";
const GROUP_HANDLE = "#ops@acme.rine.network";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";

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

describe("visibility is required, with no default anywhere", () => {
	it("refuses a create schema that names no visibility, in rine's words", () => {
		const parsed = groupCreateInput.safeParse({ name: "Ops" });
		expect(parsed.success).toBe(false);
		// Not a bare zod "Required": the refusal names both choices and what each
		// one does, so a model can pick without reading the docs.
		const message = parsed.success ? "" : parsed.error.issues[0]?.message;
		expect(message).toBe(VISIBILITY_REQUIRED);
		expect(message).toContain("dir.rine.network");
		expect(message).toContain("member-joined signal is off");
	});

	it("does not invent a visibility when one is given", () => {
		const parsed = groupCreateInput.parse({
			name: "Ops",
			visibility: "public",
		});
		expect(parsed.visibility).toBe("public");
	});

	it("tells a model both choices and the join-signal coupling in the schema", () => {
		const described = groupCreateInput.shape.visibility.description ?? "";
		expect(described).toContain("dir.rine.network");
		expect(described).toContain("member-joined signal off");
		expect(described).toContain("no default");
	});
});

describe("a roster invites, and reports per agent", () => {
	it("resolves roster handles in order and reports one outcome each", async () => {
		let createBody: Record<string, unknown> | undefined;
		h.route("GET", /^\/\.well-known\/webfinger$/, () => ({
			json: {
				subject: `acct:${PEER_HANDLE}`,
				aliases: [`${API_URL}/agents/${PEER_AGENT_ID}`],
			},
		}));
		h.route("POST", /^\/groups$/, (req) => {
			createBody = req.body as Record<string, unknown>;
			return {
				json: {
					group: groupJson(),
					roster: {
						invited: 1,
						skipped: 1,
						entries: [
							{ agent_id: PEER_AGENT_ID, status: "invited", reason: null },
							{
								agent_id: OTHER_AGENT_ID,
								status: "skipped",
								reason: "already_a_member",
							},
						],
					},
				},
			};
		});
		h.route("POST", /^\/messages$/, () => ({ json: { id: "m1" } }));

		const tool = createRineGroupCreateTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{
				name: "Ops",
				enrollment: "closed",
				visibility: "private",
				enableMls: false,
				members: [PEER_HANDLE, OTHER_AGENT_ID],
			},
			h,
		);

		expect(createBody?.members).toEqual([PEER_AGENT_ID, OTHER_AGENT_ID]);
		expect(out).toContain("1 of 2 reached; 1 new invitation to accept.");
		expect(out).toContain(`${PEER_AGENT_ID}: invited`);
		// The fact, not the wire token — a raw `not_applicable` read as a
		// refusal on exactly the groups it is not one for.
		expect(out).toContain(`${OTHER_AGENT_ID}: already a member of this group`);
		// A roster mints invitations and seats nobody. Saying otherwise is
		// what would make an operator read member_count as wrong.
		expect(out).toContain("nobody is a member until they join");
	});

	it("posts no members key and reports no roster when none was named", async () => {
		let createBody: Record<string, unknown> | undefined;
		h.route("POST", /^\/groups$/, (req) => {
			createBody = req.body as Record<string, unknown>;
			return { json: groupJson() };
		});
		const tool = createRineGroupCreateTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{
				name: "Ops",
				enrollment: "closed",
				visibility: "private",
				enableMls: false,
			},
			h,
		);
		expect(createBody).not.toHaveProperty("members");
		expect(out).not.toContain("Roster invited");
	});
});

describe("plural invite, singular untouched", () => {
	function routeGroup(over: Record<string, unknown> = {}) {
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson(over),
		}));
		h.route("POST", /^\/messages$/, () => ({ json: { id: "m1" } }));
	}

	it("posts agent_ids for a batch and reports one outcome per agent", async () => {
		let inviteBody: Record<string, unknown> | undefined;
		routeGroup();
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/invite$`), (req) => {
			inviteBody = req.body as Record<string, unknown>;
			return {
				json: {
					invited: 1,
					skipped: 1,
					entries: [
						{ agent_id: PEER_AGENT_ID, status: "invited", reason: null },
						{
							agent_id: OTHER_AGENT_ID,
							status: "skipped",
							reason: "agent_revoked",
						},
					],
				},
			};
		});
		const tool = createRineGroupInviteTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{
				group: GROUP_ID,
				agentsToInvite: [PEER_AGENT_ID, OTHER_AGENT_ID],
			},
			h,
		);
		expect(inviteBody?.agent_ids).toEqual([PEER_AGENT_ID, OTHER_AGENT_ID]);
		expect(inviteBody).not.toHaveProperty("agent_id");
		expect(out).toContain("1 of 2 reached; 1 new invitation to accept.");
		expect(out).toContain(
			`${OTHER_AGENT_ID}: that agent's identity is revoked, so it can join nothing`,
		);
	});

	// This guard is updated deliberately rather than deleted. The singular route's
	// promise is that it still posts ONE `agent_id` and answers one row — that
	// half is unchanged and still asserted. What changed is the sentence: `(status
	// invited)` printed the wire word, and the same tool can now answer `(status
	// pending)`, which claims an invitation that was not minted.
	it("leaves the singular invite posting agent_id, and names what it minted", async () => {
		let inviteBody: Record<string, unknown> | undefined;
		routeGroup();
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/invite$`), (req) => {
			inviteBody = req.body as Record<string, unknown>;
			return { json: { status: "invited", id: null } };
		});
		const tool = createRineGroupInviteTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{ group: GROUP_ID, agentToInvite: PEER_AGENT_ID },
			h,
		);
		expect(inviteBody?.agent_id).toBe(PEER_AGENT_ID);
		expect(inviteBody).not.toHaveProperty("agent_ids");
		expect(out).toBe(
			`Invited ${PEER_AGENT_ID} to ${GROUP_ID}. A closed group mints an invitation that holds a ratchet-tree seat until it is accepted or expires; an open group mints none, because nobody needs one to join it.`,
		);
	});

	// The same case, through the real wire shape: a `majority` group answers
	// the singular invite with the nomination row it filed, `status: "pending"`.
	// The old sentence read "Invited X (status pending)" — which claims an
	// invitation the server did not mint, in the one word that says otherwise.
	it("names an invite into a voting group as the nomination it filed", async () => {
		routeGroup({ enrollment_policy: "majority" });
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/invite$`), () => ({
			json: { status: "pending", id: null },
		}));
		const tool = createRineGroupInviteTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{ group: GROUP_ID, agentToInvite: PEER_AGENT_ID },
			h,
		);
		expect(out).toContain(`Nominated ${PEER_AGENT_ID} into ${GROUP_ID}.`);
		expect(out).toContain("the group's electorate decides");
		expect(out).toContain("nobody is seated until the vote carries");
		expect(out).not.toContain(`Invited ${PEER_AGENT_ID}`);
		expect(out).not.toContain("(status pending)");
	});

	it("refuses both targets, or neither, before anything reaches the wire", async () => {
		const tool = createRineGroupInviteTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const both = await runTool(
			tool,
			{
				group: GROUP_ID,
				agentToInvite: PEER_AGENT_ID,
				agentsToInvite: [OTHER_AGENT_ID],
			},
			h,
		);
		const neither = await runTool(tool, { group: GROUP_ID }, h);
		for (const out of [both, neither]) {
			expect(out).toContain("Name exactly one of agentToInvite");
		}
		expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
	});

	it("accepts a batch of at least two agents — the point of the field", () => {
		const parsed = groupInviteInput.parse({
			group: GROUP_ID,
			agentsToInvite: [PEER_AGENT_ID, OTHER_AGENT_ID],
		});
		expect(parsed.agentsToInvite).toHaveLength(2);
	});
});
