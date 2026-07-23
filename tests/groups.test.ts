/**
 * The 6 group tools, through their public Mastra `execute` interface against the
 * real SDK + a mock boundary. Covers AC-6 (enableMls accepted/MLS-latched), AC-7
 * (`[OK] MLS` render), AC-2 (error paths resolve), the handle→UUID
 * pre-resolution for invite/remove/inspect, and (NEW-1) `rine_group_join` /
 * `rine_group_invites` — the accept-side tools an invited agent previously had
 * no way to call.
 *
 * `groups.create`'s best-effort MLS init runs real rine-core MLS code against the
 * mock boundary; tests stub the MLS endpoints loosely (the init is non-fatal, so
 * a created group is returned regardless).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRineGroupCreateTool,
	createRineGroupInspectTool,
	createRineGroupInviteTool,
	createRineGroupInvitesTool,
	createRineGroupJoinTool,
	createRineGroupRemoveTool,
} from "../src/groups.js";
import {
	API_URL,
	type Harness,
	PEER_AGENT_ID,
	PEER_HANDLE,
	SELF_AGENT_ID,
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

describe("rine_group_create (AC-6 enableMls)", () => {
	it("AC-6: passes enableMls through and renders the MLS-latched group", async () => {
		let createBody: Record<string, unknown> | undefined;
		h.route("POST", /^\/groups$/, (req) => {
			createBody = req.body as Record<string, unknown>;
			// FIDELITY: the real server returns mls_group_id=null at create time and
			// latches it only on the separate MLS-init call. mls_enabled=true is the
			// signal a default-MLS group carries — the renderer must read that, not
			// mls_group_id (which is still null in this POST response).
			return {
				json: groupJson({ mls_enabled: true, mls_group_id: null }),
			};
		});
		// Best-effort MLS init touches these — keep them lenient (init is non-fatal).
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson({ mls_enabled: true, mls_group_id: null }),
		}));
		h.route("POST", /^\/groups\/.+\/mls/, () => ({ json: {} }));
		h.route("GET", /^\/groups\/.+\/mls/, () => ({ json: {} }));

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
				enableMls: true,
			},
			h,
		);

		// AC-6: enableMls latched → the result advertises MLS E2EE.
		expect(out).toContain(`Created group ${GROUP_HANDLE}`);
		expect(out).toContain("MLS E2EE");
		expect(out).toContain("enrollment closed");
		// The create body did NOT carry enableMls=false (default-on honored).
		expect(createBody).toMatchObject({ name: "Ops", visibility: "private" });
	});

	it("a sender-key group (enableMls false) renders sender-key E2EE", async () => {
		h.route("POST", /^\/groups$/, () => ({ json: groupJson() }));
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
		expect(out).toContain("sender-key E2EE");
	});
});

describe("rine_group_inspect (AC-7 [OK] MLS render + handle resolve)", () => {
	it("AC-7: an MLS group renders [OK] MLS readable/postable (the inversion)", async () => {
		h.route("GET", /^\/groups$/, () => ({
			json: {
				items: [groupJson({ mls_enabled: true, mls_group_id: "mls-abc" })],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		const tool = createRineGroupInspectTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		// Resolves the bare handle locally via groups.list() + match.
		const out = await runTool(tool, { group: GROUP_HANDLE }, h);
		expect(out).toContain("[OK] MLS group");
		expect(out).toContain("readable/postable");
		expect(out).not.toContain("[WARN]");
		expect(out).not.toContain("cannot read");
	});

	it("matches a group by its bare local name too", async () => {
		h.route("GET", /^\/groups$/, () => ({
			json: {
				items: [groupJson()],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		const tool = createRineGroupInspectTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		// "ops" (bare) matches handle "#ops@acme.rine.network".
		const out = await runTool(tool, { group: "ops" }, h);
		expect(out).toContain("[OK] sender-key group");
	});

	it("a FULL handle matches on the org, not just the bare local name", async () => {
		// Two groups share the local name "ops" but live in different orgs. A full
		// handle must match the WHOLE handle (org included) — `#ops@other-org` must
		// NOT resolve to the acme group, and `#ops@acme...` must resolve to it.
		const otherOrg = groupJson({
			id: "88888888-8888-4888-8888-888888888888",
			handle: "#ops@other-org.rine.network",
		});
		h.route("GET", /^\/groups$/, () => ({
			json: {
				items: [groupJson(), otherOrg],
				total: 2,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		const tool = createRineGroupInspectTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		// The full acme handle resolves to the acme group (id 7777…).
		const acme = await runTool(tool, { group: GROUP_HANDLE }, h);
		expect(acme).toContain(`(id ${GROUP_ID})`);
		// The full other-org handle resolves to the other-org group, NOT acme.
		const other = await runTool(
			tool,
			{ group: "#ops@other-org.rine.network" },
			h,
		);
		expect(other).toContain("(id 88888888-8888-4888-8888-888888888888)");
		expect(other).not.toContain(`(id ${GROUP_ID})`);
	});

	it("AC-2: an unknown group resolves to the not-found string", async () => {
		h.route("GET", /^\/groups$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
		const tool = createRineGroupInspectTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: "#nope@acme" }, h);
		expect(out).toContain("Not found:");
		expect(out).toContain("No group '#nope@acme'");
	});
});

describe("rine_group_invite (handle→UUID pre-resolution)", () => {
	it("resolves the group handle + agent handle to UUIDs, then invites", async () => {
		// Group resolves via groups.list().
		h.route("GET", /^\/groups$/, () => ({
			json: {
				items: [groupJson()],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		// Agent HANDLE resolves via WebFinger (NOT the public directory) — so it
		// works for an agent with no public agent card. The directory route is
		// deliberately NOT registered: a directory hit would 404 here, and the tool
		// must never touch it. WebFinger returns an alias carrying the UUID.
		h.route("GET", /^\/\.well-known\/webfinger$/, () => ({
			json: {
				subject: `acct:${PEER_HANDLE}`,
				aliases: [`${API_URL}/agents/${PEER_AGENT_ID}`],
			},
		}));
		let inviteBody: Record<string, unknown> | undefined;
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/invite$`), (req) => {
			inviteBody = req.body as Record<string, unknown>;
			return { json: { status: "invited", request_id: null } };
		});
		// MLS add-member best-effort (non-fatal).
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson(),
		}));
		h.route("POST", /^\/groups\/.+\/mls/, () => ({ json: {} }));

		const tool = createRineGroupInviteTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{ group: GROUP_HANDLE, agentToInvite: PEER_HANDLE },
			h,
		);

		expect(out).toBe(
			`Invited ${PEER_HANDLE} to ${GROUP_HANDLE} (status invited).`,
		);
		// The handle was WebFinger-resolved to the branded UUID before the wire call.
		expect(inviteBody).toMatchObject({ agent_id: PEER_AGENT_ID });
		// No directory lookup happened (WebFinger path, not inspect).
		expect(h.requests.some((r) => r.path.startsWith("/directory/"))).toBe(
			false,
		);
	});

	it("AC-2: a 403 on invite resolves to the not-authorized string", async () => {
		h.route("GET", /^\/groups$/, () => ({
			json: {
				items: [groupJson()],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/invite$`), () => ({
			status: 403,
			json: { detail: "not an admin" },
		}));
		const tool = createRineGroupInviteTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		// Pass UUIDs to skip the directory lookup for this error-path test.
		const out = await runTool(
			tool,
			{ group: GROUP_ID, agentToInvite: PEER_AGENT_ID },
			h,
		);
		expect(out).toBe("Not authorized: not an admin.");
	});
});

describe("rine_group_remove (handle→UUID pre-resolution)", () => {
	it("resolves UUIDs and removes the member; keys rotated", async () => {
		let removed = false;
		h.route(
			"DELETE",
			new RegExp(`^/groups/${GROUP_ID}/members/${PEER_AGENT_ID}$`),
			() => {
				removed = true;
				return { status: 204 };
			},
		);
		const tool = createRineGroupRemoveTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		// Pass UUIDs directly (pass-through, no list/inspect needed).
		const out = await runTool(
			tool,
			{ group: GROUP_ID, agentId: PEER_AGENT_ID },
			h,
		);
		expect(out).toBe(
			`Removed ${PEER_AGENT_ID} from ${GROUP_ID}; keys rotated.`,
		);
		expect(removed).toBe(true);
	});

	it("resolves a member by HANDLE via WebFinger (works without a public card)", async () => {
		// The member to remove need not be directory-listed — resolution must use
		// WebFinger, never the directory (which 404s for an unlisted agent). The
		// directory route is intentionally absent.
		h.route("GET", /^\/\.well-known\/webfinger$/, () => ({
			json: {
				subject: `acct:${PEER_HANDLE}`,
				aliases: [`${API_URL}/agents/${PEER_AGENT_ID}`],
			},
		}));
		h.route("GET", /^\/groups$/, () => ({
			json: {
				items: [groupJson()],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		let removed = false;
		h.route(
			"DELETE",
			new RegExp(`^/groups/${GROUP_ID}/members/${PEER_AGENT_ID}$`),
			() => {
				removed = true;
				return { status: 204 };
			},
		);
		const tool = createRineGroupRemoveTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{ group: GROUP_HANDLE, agentId: PEER_HANDLE },
			h,
		);
		expect(out).toBe(
			`Removed ${PEER_HANDLE} from ${GROUP_HANDLE}; keys rotated.`,
		);
		expect(removed).toBe(true);
		expect(h.requests.some((r) => r.path.startsWith("/directory/"))).toBe(
			false,
		);
	});
});

const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

describe("rine_group_join (invite-list resolution, NOT groups.list())", () => {
	it("resolves a group handle via the caller's pending invites, then joins immediately", async () => {
		h.route("GET", /^\/groups\/invites$/, () => ({
			json: {
				items: [
					{
						id: REQUEST_ID,
						group_id: GROUP_ID,
						agent_id: SELF_AGENT_ID,
						status: "invited",
						created_at: "2026-06-11T00:00:00.000Z",
						group_handle: GROUP_HANDLE,
						group_name: "Ops",
					},
				],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		let joinBody: Record<string, unknown> | undefined;
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/join$`), (req) => {
			joinBody = req.body as Record<string, unknown>;
			return {
				json: {
					id: "44444444-4444-4444-8444-444444444444",
					group_id: GROUP_ID,
					agent_id: SELF_AGENT_ID,
					role: "member",
					joined_at: "2026-06-11T00:00:00.000Z",
				},
			};
		});
		// MLS Welcome install best-effort (non-fatal if it 404s/errors).
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson(),
		}));

		const tool = createRineGroupJoinTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{ group: GROUP_HANDLE, message: "let me in" },
			h,
		);

		expect(out).toBe(
			`Joined ${GROUP_HANDLE} (member id 44444444-4444-4444-8444-444444444444).`,
		);
		expect(joinBody).toMatchObject({ message: "let me in" });
		// groups.list() (member-only) was never consulted for resolution.
		expect(h.requests.some((r) => /^\/groups$/.test(r.path))).toBe(false);
	});

	it("a closed-enrollment invite resolves to a pending join request", async () => {
		h.route("GET", /^\/groups\/invites$/, () => ({
			json: {
				items: [
					{
						id: REQUEST_ID,
						group_id: GROUP_ID,
						agent_id: SELF_AGENT_ID,
						status: "invited",
						created_at: "2026-06-11T00:00:00.000Z",
						group_handle: GROUP_HANDLE,
						group_name: "Ops",
					},
				],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/join$`), () => ({
			status: 202,
			json: {
				id: REQUEST_ID,
				group_id: GROUP_ID,
				agent_id: SELF_AGENT_ID,
				status: "pending",
				created_at: "2026-06-11T00:00:00.000Z",
				group_handle: GROUP_HANDLE,
				group_name: "Ops",
			},
		}));

		const tool = createRineGroupJoinTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: GROUP_HANDLE }, h);
		expect(out).toBe(
			`Join request for ${GROUP_HANDLE} is pending approval (request ${REQUEST_ID}).`,
		);
	});

	it("a bare UUID joins directly without consulting the invite list", async () => {
		let inviteListHit = false;
		h.route("GET", /^\/groups\/invites$/, () => {
			inviteListHit = true;
			return {
				json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
			};
		});
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/join$`), () => ({
			json: {
				id: "44444444-4444-4444-8444-444444444444",
				group_id: GROUP_ID,
				agent_id: SELF_AGENT_ID,
				role: "member",
				joined_at: "2026-06-11T00:00:00.000Z",
			},
		}));
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson(),
		}));

		const tool = createRineGroupJoinTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: GROUP_ID }, h);
		expect(out).toBe(
			`Joined ${GROUP_ID} (member id 44444444-4444-4444-8444-444444444444).`,
		);
		expect(inviteListHit).toBe(false);
	});

	it("AC-2: no matching invite resolves to the not-found string", async () => {
		h.route("GET", /^\/groups\/invites$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
		const tool = createRineGroupJoinTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: "#nope@acme" }, h);
		expect(out).toContain("Not found:");
		expect(out).toContain("No pending invite for group '#nope@acme'");
	});
});

describe("rine_group_invites (list the caller's pending invites)", () => {
	it("renders each pending invite with its group + request id + status", async () => {
		h.route("GET", /^\/groups\/invites$/, () => ({
			json: {
				items: [
					{
						id: REQUEST_ID,
						group_id: GROUP_ID,
						agent_id: SELF_AGENT_ID,
						status: "invited",
						created_at: "2026-06-11T00:00:00.000Z",
						group_handle: GROUP_HANDLE,
						group_name: "Ops",
					},
				],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		const tool = createRineGroupInvitesTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, {}, h);
		expect(out).toContain(GROUP_HANDLE);
		expect(out).toContain(REQUEST_ID);
		expect(out).toContain("invited");
	});

	it("the empty-state line when there are no pending invites", async () => {
		h.route("GET", /^\/groups\/invites$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
		const tool = createRineGroupInvitesTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, {}, h);
		expect(out).toBe("No pending group invites.");
	});
});
