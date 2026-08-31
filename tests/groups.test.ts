/**
 * The 6 group tools, through their public Mastra `execute` interface against the
 * real SDK + a mock boundary. Covers `enableMls` (accepted and MLS-latched),
 * the `[OK] MLS` render, error paths resolving to readable strings, the
 * handle→UUID pre-resolution for invite/remove/inspect, and `rine_group_join` /
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

describe("rine_group_create (enableMls)", () => {
	it("passes enableMls through and renders the MLS-latched group", async () => {
		let createBody: Record<string, unknown> | undefined;
		h.route("POST", /^\/groups$/, (req) => {
			createBody = req.body as Record<string, unknown>;
			// FIDELITY: the real server returns mls_group_id=null at create time and
			// latches it only on the separate MLS-init call, so the create response
			// alone can never say "MLS".
			return {
				json: groupJson({ mls_enabled: true, mls_group_id: null }),
			};
		});
		// The re-read the SDK does once the init lands — this is where the latch
		// the renderer reads comes from. Best-effort MLS init touches the rest;
		// keep them lenient (init is non-fatal).
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson({ mls_enabled: true, mls_group_id: "mls-latch-abc" }),
		}));
		h.route("POST", /^\/groups\/.+\/mls/, () => ({ json: {} }));
		h.route("GET", /^\/groups\/.+\/mls/, () => ({ json: {} }));
		// A landing init: the founder is the only member with a KeyPackage, so
		// the founding commit admits nobody and the server accepts it.
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/mls/init$`), () => ({
			json: { mls_pending: true, members: [] },
		}));
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/mls/commit$`), () => ({
			json: { epoch: 1, delivered_to: 0 },
		}));

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

		// enableMls latched → the result advertises MLS E2EE.
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

	it("a founding that landed is MLS even when the re-read after it was refused", async () => {
		// 🔴 The row is a lie here and only the create RESULT says so. The init
		// lands — the tree is founded, `mls_group_id` is latched server-side, and
		// the server will refuse a sender-key send into this group — and then the
		// re-read that would have picked the latch up is refused, so `create`
		// hands back the PRE-init row. Every MLS predicate reads that row as a
		// group whose ratchet tree was never founded.
		//
		// Telling the agent that would be four false clauses in one line, and the
		// founding's own admission is printed in the same answer when a roster is
		// named — the head would contradict the lines under it.
		h.route("POST", /^\/groups$/, () => ({
			json: groupJson({ mls_enabled: true, mls_group_id: null }),
		}));
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			status: 503,
			json: {},
		}));
		h.route("POST", /^\/groups\/.+\/mls/, () => ({ json: {} }));
		h.route("GET", /^\/groups\/.+\/mls/, () => ({ json: {} }));
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/mls/init$`), () => ({
			json: { mls_pending: true, members: [] },
		}));
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/mls/commit$`), () => ({
			json: { epoch: 1, delivered_to: 0 },
		}));

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

		expect(out).toContain(`Created group ${GROUP_HANDLE}`);
		expect(out).toContain("MLS E2EE");
		expect(out).not.toContain("never founded");
		expect(out).not.toContain("sender-key");
	});

	/**
	 * A client whose `groups.create` answers with exactly the shape the SDK
	 * hands back, so a test can name one of the create result's three MLS
	 * outcomes without driving real crypto to reach it.
	 */
	function fakeCreateClient(result: Record<string, unknown>) {
		return {
			withAgent() {
				return this;
			},
			groups: { create: async () => result },
			// biome-ignore lint/suspicious/noExplicitAny: structural fake.
		} as any;
	}

	it("says so when the group it just made really has no ratchet tree", async () => {
		// No init was attempted and none failed: the row is all there is, and it
		// says the group was created to run MLS and has no latch. Every other
		// field matches an open group's, so a head that only said "sender-key"
		// would be true and would still leave the agent believing it had made
		// the group it asked for.
		const out = await runTool(
			createRineGroupCreateTool({
				configDir: h.configDir,
				apiUrl: API_URL,
				client: fakeCreateClient(groupJson({ mls_enabled: true })),
			}),
			{ name: "Ops", enrollment: "closed", visibility: "private" },
			h,
		);

		expect(out).toContain(`Created group ${GROUP_HANDLE}`);
		expect(out).toContain("sender-key E2EE");
		expect(out).toContain("ratchet tree was never founded");
		// No verb is named, because this surface has none that would act.
		expect(out).toContain("No verb on this surface founds it");
		expect(out).not.toMatch(/broken|frozen|failed|cannot carry|holds no keys/i);
		// The note carries the fact, so the mode field does not repeat it.
		expect(out).not.toContain("(MLS never founded)");
	});

	it("a founding this client watched fail is not told it runs sender keys", async () => {
		// 🔴 `mlsInit` means the attempt did not land, and if its init POST
		// reached the server first the group is MLS-frozen: every non-MLS send
		// into it is refused until the server clears the half-started init. The
		// never-founded note promises sender-key sealing, which is exactly the
		// half this state cannot promise, so it must not be reused here.
		const out = await runTool(
			createRineGroupCreateTool({
				configDir: h.configDir,
				apiUrl: API_URL,
				client: fakeCreateClient({
					...groupJson({ mls_enabled: true }),
					mlsInit: { ok: false, reason: "Only the designated admin" },
				}),
			}),
			{ name: "Ops", enrollment: "closed", visibility: "private" },
			h,
		);

		expect(out).toContain("MLS (founding failed) E2EE");
		expect(out).toContain("has not got the MLS it was created for");
		expect(out).toContain("refuses every non-MLS send here");
		expect(out).not.toContain("its messages are sealed with sender keys");
		expect(out).not.toContain("never founded");
	});

	it("test_create_when_a_vote_window_is_named_then_the_hours_ride_the_create", async () => {
		// Declaring the field is what the schema test proves. Drop the line that
		// maps it into the create body and this tool still accepts
		// `voteDurationHours: 6`, still reports success, and founds the group on
		// the server's 72-hour default — a window wrong by 12x with every suite
		// green.
		let createBody: Record<string, unknown> | undefined;
		h.route("POST", /^\/groups$/, (req) => {
			createBody = req.body as Record<string, unknown>;
			return { json: groupJson({ enrollment_policy: "majority" }) };
		});
		const tool = createRineGroupCreateTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		await runTool(
			tool,
			{
				name: "Ops",
				enrollment: "majority",
				visibility: "private",
				enableMls: false,
				voteDurationHours: 6,
			},
			h,
		);

		expect(createBody).toMatchObject({ vote_duration_hours: 6 });
	});
});

describe("rine_group_inspect ([OK] MLS render + handle resolve)", () => {
	it("an MLS group renders [OK] MLS readable/postable (the inversion)", async () => {
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
		// 🔴 Both rows, unfiltered here: the HARNESS applies the server's own
		// `?handle=` filter (`applyHandleFilter`), because the full-handle rung now
		// lives on the server's lookup rather than a local scan. A
		// route that answered both rows to every query would hand the resolver
		// the first one whatever was asked, and this test — whose whole subject
		// is that the ORG half decides — would pass on the acme row for both
		// spellings. Driving it through the shared seam is what proves the seam.
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

	// 🔴 The resolve-fold regression, asserted as a COUNT. `rine_group_inspect`
	// wants the group ROW, and the row is what `resolveRef` answers with — so the
	// verb renders the resolve's own row. A migration that resolved to an id and
	// then called `groups.get` on it would read the same group twice, one line
	// apart, and every other assertion in this file would still be green. Two
	// group-domain requests before the fold (`GET /groups` + `GET /agents`), two
	// after, and for a UUID the group half is now the indexed row instead of the
	// org's unpaginated list.
	it("reads the group ONCE when addressed by UUID, and never lists the org", async () => {
		routeGroupRow(h, groupJson());
		const tool = createRineGroupInspectTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: GROUP_ID }, h);
		expect(out).toContain(`(id ${GROUP_ID})`);
		const paths = h.requests.map((r) => r.path);
		expect(paths.filter((path) => path === `/groups/${GROUP_ID}`)).toHaveLength(
			1,
		);
		expect(paths).not.toContain("/groups");
		// Exactly two requests leave the process, and they are these two.
		expect([...paths].sort()).toEqual(["/agents", `/groups/${GROUP_ID}`]);
	});

	it("an unknown group resolves to the not-found string", async () => {
		h.route("GET", /^\/groups$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
		const tool = createRineGroupInspectTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: "#nope@acme" }, h);
		// 🔴 The SDK's sentence, not one this package mints. The empty arm
		// names the public directory only: `rine_groups` would send a model to
		// re-read the roster it has just been told is empty.
		expect(out).toBe(
			"Not found: Group not found: #nope@acme. This org is in no groups yet. Try rine_discover_groups to search the public directory.",
		);
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

		// The sentence names what the row is, not the wire word. This
		// group is `closed`, so it really is an invitation.
		expect(out).toBe(
			`Invited ${PEER_HANDLE} to ${GROUP_HANDLE}. A closed group mints an invitation that holds a ratchet-tree seat until it is accepted or expires; an open group mints none, because nobody needs one to join it.`,
		);
		// The handle was WebFinger-resolved to the branded UUID before the wire call.
		expect(inviteBody).toMatchObject({ agent_id: PEER_AGENT_ID });
		// No directory lookup happened (WebFinger path, not inspect).
		expect(h.requests.some((r) => r.path.startsWith("/directory/"))).toBe(
			false,
		);
	});

	it("a 403 on invite resolves to the not-authorized string", async () => {
		h.route("GET", /^\/groups$/, () => ({
			json: {
				items: [groupJson()],
				total: 1,
				next_cursor: null,
				prev_cursor: null,
			},
		}));
		// The group's own row, so the resolve succeeds and the 403 under test is
		// the INVITE's. Without it the refusal would be the resolver's and the
		// assertion would read the same shape for a different defect.
		routeGroupRow(h, groupJson());
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
	it("resolves UUIDs and removes the member", async () => {
		let removed = false;
		// The SDK reads the group before removing, because the true sentence
		// differs between the two group types. This one runs sender keys.
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson(),
		}));
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
		// The sentence is the SDK's, and it is accurate for THIS group
		// type. An open group has no cryptographic eviction, so the tool must not
		// imply one — the shipped "rejoining is the only way back in" was false
		// here. Composing a second sentence in this package is how that happened.
		expect(out).toContain(`Removed ${PEER_AGENT_ID} from group`);
		expect(out).toContain("no cryptographic eviction");
		expect(out).toContain("rotating their sender key on their next send");
		expect(out).not.toContain("only way back in");
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
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson(),
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
		// The handles the caller typed are resolved to UUIDs before the DELETE, and
		// the SDK's sentence names what it acted on. Echoing the caller's own words
		// back would mean composing a second sentence here — see the UUID case.
		expect(out).toContain(`Removed ${PEER_AGENT_ID} from group`);
		expect(removed).toBe(true);
		expect(h.requests.some((r) => r.path.startsWith("/directory/"))).toBe(
			false,
		);
	});
});

const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

/**
 * `join` is the one group verb aimed at a group this org is by definition NOT
 * in, so it does not resolve through `groups.list()` like its five siblings. It
 * hands the reference to the SDK's join-scoped ladder — the org's own seats by
 * exact handle, then this agent's invitations, then the public directory — and
 * reads a bare name against those invitations alone. Driven end to end here:
 * the mock boundary is HTTP, so every rung is a real request this suite can see.
 */
describe("rine_group_join (the join-scoped ladder, NOT groups.list())", () => {
	it("resolves a group handle via the caller's pending invites, then joins immediately", async () => {
		h.route("GET", /^\/groups$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
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
		// The org-scoped rung is asked by EXACT handle — `?handle=`, which the
		// server matches whole — and never as the unfiltered member list the other
		// five verbs page through. A join cannot be answered by "one of yours".
		const ownGroups = h.requests.filter((r) => /^\/groups$/.test(r.path));
		expect(ownGroups).toHaveLength(1);
		expect(ownGroups[0]?.url).toContain("handle=");
	});

	it("a closed-enrollment invite resolves to a pending join request", async () => {
		h.route("GET", /^\/groups$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
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

	it("a public group with no relationship resolves through the directory", async () => {
		// The MEASURED defect this ladder exists for: a handle read straight off
		// `rine_discover_groups` — no seat, no invitation — was refused here
		// client-side, with the server never having been asked anything.
		h.route("GET", /^\/groups$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
		h.route("GET", /^\/groups\/invites$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
		h.route("GET", /^\/directory\/groups$/, () => ({
			json: {
				items: [
					{ id: GROUP_ID, name: "ops", handle: GROUP_HANDLE },
					{ id: REQUEST_ID, name: "ops-archive", handle: "#ops-archive@acme.rine.network" },
				],
				total: 2,
				next_cursor: null,
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
		// The directory's filter is a name/description ILIKE, so it hands back
		// candidates. The handle is what decides which one — the near-miss row
		// above is in the same page and is not the group that was joined.
		const lookup = h.requests.find((r) => /^\/directory\/groups$/.test(r.path));
		expect(lookup?.url).toContain("q=ops");
	});

	it("a handle no rung answers resolves to the not-found string", async () => {
		h.route("GET", /^\/groups$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
		h.route("GET", /^\/groups\/invites$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
		h.route("GET", /^\/directory\/groups$/, () => ({
			json: { items: [], total: 0, next_cursor: null },
		}));
		const tool = createRineGroupJoinTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: "#nope@acme" }, h);
		// Leads with `Group not found`, which is what `formatError` keys on to add
		// this surface's own discover verbs — the old `No pending invite` wording
		// matched none of its spellings, so a refused join carried no remedy.
		expect(out).toContain("Not found: Group not found: #nope@acme");
		expect(out).toContain("rine_discover_groups");
	});

	it("a bare name an invitation names spends that invitation, and reads nothing wider", async () => {
		// The five sibling verbs all take a bare name, and so does this one — but
		// against ONE set: the invitations already addressed to this agent. That
		// set is bounded to groups that have asked for this agent, so a match in
		// it cannot be a group the caller has no business in, which is what makes
		// a reference carrying no org safe in front of an irreversible verb.
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
			},
		}));
		h.route("POST", new RegExp(`^/groups/${GROUP_ID}/join$`), () => ({
			json: {
				id: "77777777-7777-4777-8777-777777777777",
				group_id: GROUP_ID,
				agent_id: SELF_AGENT_ID,
				role: "member",
				joined_at: "2026-06-11T00:00:00.000Z",
			},
		}));

		const tool = createRineGroupJoinTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: "ops" }, h);

		expect(out).toContain("Joined");
		// The two rungs a bare name must not reach: this org's seats say nothing
		// about a group it is not in, and the directory is a network-wide ILIKE
		// with no org in the reference to tell two `ops` groups apart.
		expect(h.requests.some((r) => /^\/groups$/.test(r.path))).toBe(false);
		expect(h.requests.some((r) => r.path.startsWith("/directory/"))).toBe(
			false,
		);
	});

	it("a bare name no invitation names is refused, naming what to hand it instead", async () => {
		// Deliberate and settled: the only rung that could
		// see a group this agent has no relationship with is a network-wide ILIKE,
		// and a bare name has no exactness filter to put behind it. A join cannot
		// be taken back, so it is never aimed at a guess.
		h.route("GET", /^\/groups\/invites$/, () => ({
			json: { items: [], total: 0, next_cursor: null },
		}));
		const tool = createRineGroupJoinTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: "ops" }, h);

		expect(out).toContain("Not found: Group not found: ops");
		expect(out).toContain(
			"A bare name is read as one of this agent's pending invitations",
		);
		expect(out).toContain("Join takes a group's whole handle");
		expect(h.requests.some((r) => /^\/groups$/.test(r.path))).toBe(false);
		expect(h.requests.some((r) => r.path.startsWith("/directory/"))).toBe(
			false,
		);
	});

	it("two invitations of that name are both printed rather than one being guessed at", async () => {
		// Two orgs may each call a group `ops`, and a bare name carries no org to
		// tell them apart. The handles do, so they are what the refusal prints.
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
					{
						id: "88888888-8888-4888-8888-888888888888",
						group_id: "88888888-8888-4888-8888-888888888888",
						agent_id: SELF_AGENT_ID,
						status: "invited",
						created_at: "2026-06-11T00:00:00.000Z",
						group_handle: "#ops@other.rine.network",
						group_name: "Ops",
					},
				],
				total: 2,
				next_cursor: null,
			},
		}));
		const tool = createRineGroupJoinTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { group: "ops" }, h);

		expect(out).toContain(
			"More than one of this agent's pending invitations",
		);
		expect(out).toContain(GROUP_HANDLE);
		expect(out).toContain("#ops@other.rine.network");
		expect(h.requests.some((r) => /\/join$/.test(r.path))).toBe(false);
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
