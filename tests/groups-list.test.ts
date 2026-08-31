/**
 * The three group READ tools — `rine_groups`, `rine_discover_groups`,
 * `rine_group_roster` — through their public Mastra `execute` interface against
 * the real SDK and a mock HTTP boundary.
 *
 * They are read verbs, so what is worth asserting is what each one CLAIMS and
 * what it puts on the wire: a directory row must not claim an encryption mode
 * the directory never reports, and the roster must reach
 * `GET /groups/{id}/members` with a UUID the tool resolved itself.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	NO_CONVERSATION,
	NO_OWN_AGENTS,
} from "../src/format-groups-list.js";
import {
	createRineDiscoverGroupsTool,
	createRineGroupRosterTool,
	createRineGroupsTool,
} from "../src/groups-list.js";
import {
	API_URL,
	type Harness,
	SELF_AGENT_ID,
	SELF_AGENT_NAME,
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
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const OWN_AGENT = "44444444-4444-4444-4444-444444444444";
const OTHER_OWN_AGENT = "55555555-5555-4555-8555-555555555555";
const OTHER_ORG_AGENT = "99999999-9999-4999-8999-999999999999";

function page(items: unknown[]) {
	return { json: { items, total: items.length, next_cursor: null, prev_cursor: null } };
}

function groupJson(over: Record<string, unknown> = {}) {
	return {
		id: GROUP_ID,
		name: "Ops",
		handle: GROUP_HANDLE,
		enrollment_policy: "closed",
		visibility: "private",
		created_at: "2026-06-11T00:00:00.000Z",
		member_count: 4,
		mls_enabled: false,
		mls_group_id: null,
		mls_pending: false,
		...over,
	};
}

const opts = () => ({ configDir: h.configDir, apiUrl: API_URL });

describe("rine_groups", () => {
	it("renders every group with its mode, policy and member count", async () => {
		h.route("GET", /^\/groups$/, () =>
			page([
				groupJson({ mls_enabled: true, mls_group_id: "mls-latch" }),
				groupJson({
					id: "88888888-8888-4888-8888-888888888888",
					handle: "#lobby@acme.rine.network",
					enrollment_policy: "open",
					member_count: 12,
				}),
			]),
		);
		const out = await runTool(createRineGroupsTool(opts()), {}, h);
		expect(out).toContain(`1. ${GROUP_HANDLE}`);
		expect(out).toContain("MLS, enrollment closed, 4 member(s)");
		expect(out).toContain("2. #lobby@acme.rine.network");
		expect(out).toContain("sender-key, enrollment open, 12 member(s)");
	});

	it("tells a group created to run MLS with no ratchet tree apart from an open one", async () => {
		// The two rows below are field for field identical to a reader that only
		// looks at the latch columns — both are unlatched, neither has an init in
		// flight — and until the row named the fourth state they rendered the
		// same two words. The first is a group created to run MLS whose ratchet
		// tree was never founded; the second is an open group, which never had
		// one to found. Only the enrollment/`mls_enabled` pair separates them.
		h.route("GET", /^\/groups$/, () =>
			page([
				groupJson({ mls_enabled: true }),
				groupJson({
					id: "88888888-8888-4888-8888-888888888888",
					handle: "#lobby@acme.rine.network",
					enrollment_policy: "open",
					mls_enabled: true,
				}),
			]),
		);
		const out = await runTool(createRineGroupsTool(opts()), {}, h);
		expect(out).toContain("sender-key (MLS never founded), enrollment closed");
		expect(out).toContain("sender-key, enrollment open");
		// The row is comma-separated and the note is not the row's to carry: a
		// field holding a comma changes how many fields a reader counts.
		expect(out).not.toContain("never founded,");
	});

	it("carries each group's conversation id through the SDK's own parse", async () => {
		// The one assertion in this package that closes the loop end to end: the
		// row is built from a REAL `GroupReadSchema.parse` of the wire body, and
		// that schema strips every key it was not told about. A `rine-ts-sdk`
		// that forgot the field, or a stale `rine-ts-sdk/dist`, fails here and
		// nowhere else in this package — every other group test would still read
		// green while the id silently stopped arriving.
		//
		// Both arms, deliberately. A group nobody has posted in has no
		// conversation yet (the thread is created lazily on the first post), and
		// a clause that vanishes on that group reads to a model as a rendering
		// fault rather than as a fact about the group.
		h.route("GET", /^\/groups$/, () =>
			page([
				groupJson({ conversation_id: CONVERSATION_ID }),
				groupJson({
					id: "88888888-8888-4888-8888-888888888888",
					handle: "#lobby@acme.rine.network",
					conversation_id: null,
				}),
			]),
		);
		const out = await runTool(createRineGroupsTool(opts()), {}, h);
		expect(out).toContain(`conversation_id=${CONVERSATION_ID}`);
		expect(out).toContain(`conversation_id=${NO_CONVERSATION}`);
		expect(out).not.toContain("conversation_id=null");
		expect(out).not.toContain("conversation_id=undefined");
	});

	it("carries which of this org's agents are seated, through the SDK's own parse", async () => {
		// The end-to-end assertion for `member_agent_ids` in this package: the
		// row is built from a REAL `GroupReadSchema.parse` of the wire body, and
		// that schema strips every key it was not told about. A `rine-ts-sdk`
		// that forgot the field, or a stale `rine-ts-sdk/dist`, fails HERE and
		// nowhere else — every other group test would still read green while
		// the answer to "may this agent act here" silently stopped arriving.
		//
		// Both arms, deliberately. The empty one is the row that says a send
		// would be refused, and it is the row a model most needs to read.
		h.route("GET", /^\/groups$/, () =>
			page([
				groupJson({ member_agent_ids: [OWN_AGENT, OTHER_OWN_AGENT] }),
				groupJson({
					id: "88888888-8888-4888-8888-888888888888",
					handle: "#lobby@acme.rine.network",
					member_agent_ids: [],
				}),
			]),
		);
		const out = await runTool(createRineGroupsTool(opts()), {}, h);
		// Resolved against this org's own agent list: the acting agent
		// knows its handle and does not know its UUID, so a row of UUIDs could
		// not be acted on. Neither id is in the harness's default `/agents`
		// answer, so both fall to case 2 and print as themselves — which is the
		// degradation this clause is allowed to have and the one asserted below.
		expect(out).toContain(`your agents: ${OWN_AGENT}, ${OTHER_OWN_AGENT}`);
		expect(out).toContain(`your agents: ${NO_OWN_AGENTS}`);
		expect(out).not.toContain("your agents: undefined");
		// `member_count` is the WHOLE roster and is untouched: the new clause is
		// this org's share of it, never a replacement for it.
		expect(out).toContain("4 member(s)");
	});

	it("names the seated agents by handle, not by UUID", async () => {
		// The rule, end to end and through the SDK's own `GET /agents` parse:
		// an id this org owns prints its handle, an id it does not own prints
		// itself. A handle is what the model reads and what every group verb
		// takes; a UUID is neither.
		h.route("GET", /^\/groups$/, () =>
			page([
				groupJson({
					member_agent_ids: [SELF_AGENT_ID, OTHER_ORG_AGENT],
				}),
			]),
		);
		const out = await runTool(createRineGroupsTool(opts()), {}, h);
		expect(out).toContain(
			`your agents: ${SELF_AGENT_NAME}@acme.rine.network, ${OTHER_ORG_AGENT}`,
		);
		expect(out).not.toContain(SELF_AGENT_ID);
	});

	it("prints the UUIDs when the agent list cannot be read at all", async () => {
		// The group list already succeeded. A failing `GET /agents` costs the
		// handles and never the answer — the row degrades to what it printed
		// before handle resolution existed, and the tool does not refuse.
		h.route("GET", /^\/groups$/, () =>
			page([groupJson({ member_agent_ids: [SELF_AGENT_ID] })]),
		);
		h.route("GET", /^\/agents$/, () => ({ status: 503, json: {} }));
		const out = await runTool(createRineGroupsTool(opts()), {}, h);
		expect(out).toContain(`your agents: ${SELF_AGENT_ID}`);
		expect(out).toContain(GROUP_HANDLE);
	});

	it("reports the empty state rather than an empty string", async () => {
		h.route("GET", /^\/groups$/, () => page([]));
		const out = await runTool(createRineGroupsTool(opts()), {}, h);
		expect(out).toBe("This agent belongs to no groups.");
	});
});

describe("rine_discover_groups", () => {
	it("puts the query on the wire and renders each public group", async () => {
		let queryUrl = "";
		h.route("GET", /^\/directory\/groups$/, (req) => {
			queryUrl = req.url;
			return page([
				{
					id: GROUP_ID,
					name: "Ops",
					handle: GROUP_HANDLE,
					description: "shift handover",
					enrollment_policy: "open",
					visibility: "public",
					member_count: 9,
				},
			]);
		});
		const out = await runTool(
			createRineDiscoverGroupsTool(opts()),
			{ q: "ops", limit: 10 },
			h,
		);
		expect(queryUrl).toContain("q=ops");
		expect(queryUrl).toContain("limit=10");
		expect(out).toContain(`1. ${GROUP_HANDLE}`);
		expect(out).toContain("enrollment open, 9 member(s)");
		expect(out).toContain("shift handover");
	});

	it("says what the list is before the rows, so it cannot be read as a membership list", async () => {
		// `rine_groups` above prints near-identical numbered rows and every one
		// of those IS a group this org holds a seat in. This route carries no
		// identity at all, so no row here can answer that question — and two
		// numbered lists told apart by nothing but the tool's own name is how a
		// directory hit gets read as a seat.
		h.route("GET", /^\/directory\/groups$/, () =>
			page([
				{
					id: GROUP_ID,
					name: "Ops",
					handle: GROUP_HANDLE,
					enrollment_policy: "closed",
					visibility: "public",
					member_count: 2,
				},
			]),
		);
		const out = await runTool(
			createRineDiscoverGroupsTool(opts()),
			{ limit: 10 },
			h,
		);
		expect(out.split("\n")[0]).toBe(
			"1 public group(s) found in the directory. A row here is a group that exists, not a group this agent is in:",
		);
		expect(out).toContain(`1. ${GROUP_HANDLE}`);
		// The header states what the caller is looking at and names no verb —
		// which tool to reach for next is the tool description's sentence.
		expect(out).not.toContain("rine_group_join");
	});

	it("names the verb that acts on a row it found", () => {
		// This is the one tool on this surface that returns groups the calling
		// org holds no seat in, and the route it reads carries no identity — so
		// a row here can never say whether the agent is in the group, and the
		// description is the only place the next step can be stated. The
		// assertion is the verb, not the wording around it.
		const description = createRineDiscoverGroupsTool(opts()).description ?? "";
		expect(description).toContain("rine_group_join");
		expect(description).toContain("not a group your agent is in");
	});

	it("claims no encryption mode — the directory reports none", async () => {
		h.route("GET", /^\/directory\/groups$/, () =>
			page([
				{
					id: GROUP_ID,
					name: "Ops",
					handle: GROUP_HANDLE,
					enrollment_policy: "closed",
					visibility: "public",
					member_count: 2,
				},
			]),
		);
		const out = await runTool(
			createRineDiscoverGroupsTool(opts()),
			{ limit: 10 },
			h,
		);
		expect(out).not.toContain("MLS");
		expect(out).not.toContain("sender-key");
	});

	it("reports the empty state rather than an empty string", async () => {
		h.route("GET", /^\/directory\/groups$/, () => page([]));
		const out = await runTool(
			createRineDiscoverGroupsTool(opts()),
			{ limit: 10 },
			h,
		);
		expect(out).toBe("No public groups matched.");
	});
});

describe("rine_group_roster", () => {
	it("resolves a handle to a UUID, then renders handle, role and join date", async () => {
		h.route("GET", /^\/groups$/, () => page([groupJson()]));
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}/members$`), () =>
			page([
				{
					group_id: GROUP_ID,
					agent_id: "11111111-1111-4111-8111-111111111111",
					agent_handle: "ana@acme",
					role: "admin",
					joined_at: "2026-06-01T00:00:00.000Z",
				},
				{
					group_id: GROUP_ID,
					agent_id: "22222222-2222-4222-8222-222222222222",
					agent_handle: null,
					role: "member",
					joined_at: "2026-06-02T00:00:00.000Z",
				},
			]),
		);
		const out = await runTool(
			createRineGroupRosterTool(opts()),
			{ group: GROUP_HANDLE },
			h,
		);
		// The roster reached the resolved UUID, not the handle the model gave.
		expect(
			h.requests.some((r) => r.path === `/groups/${GROUP_ID}/members`),
		).toBe(true);
		expect(out).toContain("1. ana@acme — admin, joined 2026-06-01");
		// No handle on the wire falls back to the agent id, never to blank.
		expect(out).toContain(
			"2. 22222222-2222-4222-8222-222222222222 — member, joined 2026-06-02",
		);
	});

	it("marks this org's own rows and hides none of the others", async () => {
		// `is_own_org` is a MARKER, never a filter — and it too is read through
		// a real `GroupMemberSchema.parse`, so a schema that dropped the field
		// fails here. The roster is the whole group across every org; the mark
		// only says which of those seats this host could act as. Filtering on it
		// would contradict `member_count`, which counts them all.
		h.route("GET", /^\/groups$/, () => page([groupJson()]));
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}/members$`), () =>
			page([
				{
					group_id: GROUP_ID,
					agent_id: OWN_AGENT,
					agent_handle: "ana@acme",
					role: "admin",
					joined_at: "2026-06-01T00:00:00.000Z",
					is_own_org: true,
				},
				{
					group_id: GROUP_ID,
					agent_id: OTHER_ORG_AGENT,
					agent_handle: "bo@beta",
					role: "member",
					joined_at: "2026-06-02T00:00:00.000Z",
					is_own_org: false,
				},
			]),
		);
		const out = await runTool(
			createRineGroupRosterTool(opts()),
			{ group: GROUP_HANDLE },
			h,
		);
		expect(out).toContain("1. ana@acme — admin, joined 2026-06-01 (yours)");
		// Present, and unmarked — the other org's seat is still a member.
		expect(out).toContain("2. bo@beta — member, joined 2026-06-02");
		expect(out).not.toContain("bo@beta — member, joined 2026-06-02 (yours)");
	});

	// 🔴 The sentence changed and the change is the point: the refusal
	// is the SDK's now, one sentence for every surface, where it used to be a
	// wording this package minted for itself. An org with no groups gets the
	// empty arm, which names the directory and NOT `rine_groups` — telling a
	// model to go and list a roster it has just been told is empty is a loop
	// this surface removed.
	it("reports a group this agent is not in rather than an empty roster", async () => {
		h.route("GET", /^\/groups$/, () => page([]));
		const out = await runTool(
			createRineGroupRosterTool(opts()),
			{ group: "#nope@acme" },
			h,
		);
		expect(out).toBe(
			"Not found: Group not found: #nope@acme. This org is in no groups yet. Try rine_discover_groups to search the public directory.",
		);
		// No roster was read, so nothing was listed for the caller to look at.
		expect(out).not.toContain("Name one of these groups");
	});
});

/**
 * What the group ladder does with the three answers `GET /groups/{id}`
 * can give that are not the row.
 *
 * `rine_group_roster` is the vehicle because it is the smallest UUID-addressed
 * read verb on this surface: one resolve, one members page, no writes and no
 * MLS state, so a difference in what comes back is a difference in the ladder.
 */
describe("a UUID-addressed group verb, when the group's own row does not come back", () => {
	const opts = () => ({ configDir: h.configDir, apiUrl: API_URL });

	async function roster(status: number, detail: string): Promise<string> {
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			status,
			json: { detail },
		}));
		h.route("GET", /^\/groups$/, () => page([groupJson()]));
		return await runTool(
			createRineGroupRosterTool(opts()),
			{ group: GROUP_ID },
			h,
		);
	}

	// 🔴 404 and 403 are the same refusal ON PURPOSE, and a byte comparison is
	// the only assertion that can hold it: an id belonging to somebody else's
	// group and an id belonging to no group must be indistinguishable, or the
	// pair of them is an oracle for whether a UUID names a real group anywhere
	// on the network. Asserted as equality between the two outputs rather than
	// against a literal, so a reword cannot pass one and fail the other.
	it("refuses a 403 and a 404 identically, to the byte", async () => {
		const forbidden = await roster(403, "not a member");
		// Newest route wins, so the second call re-registers the same path with
		// the other status against the same harness.
		const missing = await roster(404, "Group not found");
		expect(forbidden).toBe(missing);
		expect(forbidden).toContain("Group not found:");
		// The refusal is the ladder's, and it names what the org DOES have —
		// neither server detail reaches the model.
		expect(forbidden).not.toContain("not a member");
		expect(forbidden).toContain("Name one of these groups");
	});

	// 🔴 A 500 is NOT a refusal and must not be swallowed into one. The ladder
	// treats 404 and 403 as "you may not read this id" and falls through to the
	// roster; anything else is the server failing, and reporting it as a missing
	// group would send a model off to re-spell a reference that was right.
	it("propagates a 500 as a 500 rather than reporting a missing group", async () => {
		const out = await roster(500, "database is on fire");
		expect(out).toBe("500: database is on fire");
		expect(out).not.toContain("Group not found");
	});
});
