/**
 * The five admission verbs on the Mastra surface: `rine_group_requests`,
 * `rine_group_vote`, `rine_group_leave`, `rine_group_sync`,
 * `rine_group_reclaim`.
 *
 * Driven through the public `execute` interface against the real SDK and the
 * mock HTTP boundary, so what is asserted is the request that leaves the
 * process and the sentence the model gets back. The two verbs whose truth
 * differs by group type return the SDK's own sentence — the assertion there is
 * that this package did not compose a second one.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderRequests } from "../src/format-groups.js";
import {
	createRineGroupLeaveTool,
	createRineGroupReclaimTool,
	createRineGroupRequestsTool,
	createRineGroupSyncTool,
	createRineGroupVoteTool,
} from "../src/groups-admin.js";
import type { JoinRequestRead } from "../src/types.js";
import {
	API_URL,
	type Harness,
	PEER_AGENT_ID,
	SELF_AGENT_ID,
	makeHarness,
	routeGroupRow,
	runTool,
} from "./harness.js";

let h: Harness;

// Every verb in this file is addressed by UUID, and a UUID-addressed group verb
// reads the group's own row before it acts — so the row is a
// PRECONDITION of the suite, not a per-test fixture, and it is registered once
// here. A test that wants that read to fail registers its own handler for the
// route (newest wins), which is how the 404/403/500 cases below say so.
beforeEach(() => {
	h = makeHarness();
	routeGroupRow(h, groupJson());
});
afterEach(() => {
	h.cleanup();
});

const GROUP_ID = "77777777-7777-4777-8777-777777777777";
const GROUP_HANDLE = "#ops@acme.rine.network";
const REQUEST_ID = "88888888-8888-4888-8888-888888888888";

function groupJson(over: Record<string, unknown> = {}) {
	return {
		id: GROUP_ID,
		name: "Ops",
		handle: GROUP_HANDLE,
		enrollment_policy: "majority",
		visibility: "private",
		created_at: "2026-08-03T00:00:00.000Z",
		mls_enabled: false,
		mls_group_id: null,
		mls_pending: false,
		...over,
	};
}

/**
 * The record `client.groups.resolveRef` answers with — the group's id, the
 * handle the wire takes, the caller's spelling, and the row the resolve read.
 *
 * For the four tests below that fake the CLIENT because the verb underneath
 * them needs real MLS state on disk. 🔴 It answers the whole record and not a
 * bare id on purpose: a fake that handed the verb a string would let the verb
 * go on compiling if someone re-narrowed it to a `GroupUuid`, and the fold the
 * record exists for would be gone with every test still green. What the resolve
 * itself DOES over HTTP is asserted by the rest of this file, which drives the
 * real client against the mock boundary.
 */
function resolvedGroup(over: Record<string, unknown> = {}) {
	const row = groupJson(over);
	return { id: row.id, handle: row.handle, spelling: row.id, row };
}

function requestRow(over: Record<string, unknown> = {}) {
	return {
		id: REQUEST_ID,
		group_id: GROUP_ID,
		agent_id: PEER_AGENT_ID,
		status: "pending",
		expires_at: "2026-08-10T00:00:00.000Z",
		created_at: "2026-08-03T00:00:00.000Z",
		...over,
	};
}

/** The last recorded request whose path matches. */
function lastUrl(h: Harness, path: string): string {
	const hit = [...h.requests].reverse().find((r) => r.path === path);
	if (!hit) throw new Error(`no request to ${path}`);
	return hit.url;
}

const opts = () => ({ configDir: h.configDir, apiUrl: API_URL });

describe("rine_group_requests", () => {
	it("asks for the vote queue when no filter was named", async () => {
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}/requests$`), () => ({
			json: { items: [requestRow()], next_cursor: null },
		}));
		const out = await runTool(
			createRineGroupRequestsTool(opts()),
			{ group: GROUP_ID, outstanding: "pending" },
			h,
		);
		expect(lastUrl(h, `/groups/${GROUP_ID}/requests`)).toContain(
			"outstanding=pending",
		);
		// The group reference the caller gave, not a UUID it never named.
		expect(out).toContain(`Outstanding in \`${GROUP_ID}\` (pending): 1`);
		expect(out).toContain(REQUEST_ID);
		expect(out).toContain(PEER_AGENT_ID);
		expect(out).toContain("expires 2026-08-10T00:00:00.000Z");
	});

	it("passes `live` through — members plus live is the whole tree", async () => {
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}/requests$`), () => ({
			json: { items: [], next_cursor: null },
		}));
		const out = await runTool(
			createRineGroupRequestsTool(opts()),
			{ group: GROUP_ID, outstanding: "live" },
			h,
		);
		expect(lastUrl(h, `/groups/${GROUP_ID}/requests`)).toContain(
			"outstanding=live",
		);
		expect(out).toBe(
			`Nothing outstanding in \`${GROUP_ID}\` under filter \`live\`.`,
		);
	});
});

describe("rine_group_vote", () => {
	it("posts the choice and says nothing about seating while pending", async () => {
		let body: Record<string, unknown> | undefined;
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}/requests$`), () => ({
			json: { items: [requestRow()], next_cursor: null },
		}));
		h.route(
			"POST",
			new RegExp(`^/groups/${GROUP_ID}/requests/${REQUEST_ID}/vote$`),
			(req) => {
				body = req.body as Record<string, unknown>;
				return {
					json: {
						request_id: REQUEST_ID,
						your_vote: "approve",
						status: "pending",
					},
				};
			},
		);
		const out = await runTool(
			createRineGroupVoteTool(opts()),
			{ group: GROUP_ID, requestId: REQUEST_ID, vote: "approve" },
			h,
		);
		expect(body).toEqual({ vote: "approve" });
		expect(out).toContain("Vote `approve` recorded on request");
		expect(out).toContain("Request status: `pending`.");
		expect(out).not.toContain("now a member");
	});

	it("never claims a leaf and a Welcome the vote did not mint", async () => {
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}/requests$`), () => ({
			json: { items: [requestRow()], next_cursor: null },
		}));
		// The SDK re-reads the group and seats the applicant in MLS inside vote()
		// — best-effort, so the vote's own answer stands either way. It cannot
		// succeed against this harness (there is no ratchet tree behind it), which
		// is precisely the case the sentence used to lie about: on the server's
		// `approved` alone this asserted a leaf and a Welcome that were never
		// minted. `mls_seated` is what the renderer conditions on now.
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson({ mls_enabled: true, mls_group_id: "mls-1" }),
		}));
		h.route(
			"POST",
			new RegExp(`^/groups/${GROUP_ID}/requests/${REQUEST_ID}/vote$`),
			() => ({
				json: {
					request_id: REQUEST_ID,
					your_vote: "approve",
					status: "approved",
				},
			}),
		);
		const out = await runTool(
			createRineGroupVoteTool(opts()),
			{ group: GROUP_ID, requestId: REQUEST_ID, vote: "approve" },
			h,
		);
		expect(out).toContain("The applicant is now a member.");
		expect(out).toContain("resume-admission");
		expect(out).not.toContain("were minted as part of this vote");
	});

	// A carried vote on a nomination the nominee never
	// consented to resolves the row to `invited`, not to a seat — and no stack
	// anticipated the word. Falling through to the bare status line hands a model
	// a status no other outcome of this tool uses.
	it("names the carried vote that produced an invitation rather than a member", async () => {
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}/requests$`), () => ({
			json: { items: [requestRow()], next_cursor: null },
		}));
		h.route(
			"POST",
			new RegExp(`^/groups/${GROUP_ID}/requests/${REQUEST_ID}/vote$`),
			() => ({
				json: {
					request_id: REQUEST_ID,
					your_vote: "approve",
					status: "invited",
				},
			}),
		);
		const out = await runTool(
			createRineGroupVoteTool(opts()),
			{ group: GROUP_ID, requestId: REQUEST_ID, vote: "approve" },
			h,
		);
		expect(out).toContain("Request status: `invited`.");
		expect(out).toContain("The electorate approved it");
		expect(out).toContain("holds a spendable invitation rather than a seat");
		expect(out).toContain("becomes a member when it accepts");
		// Neither of the two sentences an approve-and-seat prints.
		expect(out).not.toContain("The applicant is now a member");
		expect(out).not.toContain("were minted as part of this vote");
	});

	it("reports a denial as a denial", async () => {
		h.route(
			"POST",
			new RegExp(`^/groups/${GROUP_ID}/requests/${REQUEST_ID}/vote$`),
			() => ({
				json: { request_id: REQUEST_ID, your_vote: "deny", status: "denied" },
			}),
		);
		const out = await runTool(
			createRineGroupVoteTool(opts()),
			{ group: GROUP_ID, requestId: REQUEST_ID, vote: "deny" },
			h,
		);
		expect(out).toContain("Vote `deny` recorded");
		expect(out).toContain("Request status: `denied`.");
		expect(out).not.toContain("now a member");
	});
});

describe("rine_group_leave", () => {
	it("deletes this agent's own membership and returns the SDK's sentence", async () => {
		let deleted: string | undefined;
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson({ enrollment_policy: "open" }),
		}));
		h.route(
			"DELETE",
			new RegExp(`^/groups/${GROUP_ID}/members/${SELF_AGENT_ID}$`),
			(req) => {
				deleted = req.path;
				return { status: 204 };
			},
		);
		const out = await runTool(
			createRineGroupLeaveTool(opts()),
			{ group: GROUP_ID },
			h,
		);
		expect(deleted).toBe(`/groups/${GROUP_ID}/members/${SELF_AGENT_ID}`);
		// The sentence is the SDK's, and it is accurate for THIS group
		// type — an open group's wipe is not an eviction, and this package must
		// not imply one by composing a sentence of its own.
		expect(out).toContain(`You left group ${GROUP_HANDLE}.`);
		expect(out).toContain("rotating their sender key on their next send");
	});
});

describe("rine_group_sync", () => {
	it("recovers a sender-key group through the real SDK, and writes nothing", async () => {
		// 🔴 The real client, not a structural fake. A fake `groups.sync` issues
		// no HTTP at all, which leaves `h.requests` empty — so the zero-POST
		// assertion below would read green because nothing ran, not because a
		// sender-key recovery posts nothing. The whole cost claim in this tool's
		// shipped description is that second sentence, so it has to be measured
		// at the boundary the requests actually cross.
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}$`), () => ({
			json: groupJson({ enrollment_policy: "open" }),
		}));
		// The distribution inbox the recovery scans. Empty is the ordinary answer
		// for a member whose peers have all already sent.
		h.route(
			"GET",
			new RegExp(`^/agents/${SELF_AGENT_ID}/messages$`),
			() => ({ json: { items: [], total: 0, next_cursor: null } }),
		);

		const out = await runTool(
			createRineGroupSyncTool(opts()),
			{ group: GROUP_ID },
			h,
		);

		// The one TypeScript wording, from rine-core — the same sentence the CLI
		// and MCP print, and the twin of the Python connectors'.
		expect(out).toContain("nothing new was installed");
		expect(out).toContain("nothing was committed and this cost reads only");
		// An open group has no ratchet tree, so no eviction sentence can belong
		// to this answer: an open group's removals are the server's delivery
		// filter, not an MLS Remove.
		expect(out).not.toContain("was removed from the group");
		// The scan really ran, so the assertion below is over a populated log.
		expect(
			h.requests.some(
				(r) => r.path === `/agents/${SELF_AGENT_ID}/messages`,
			),
		).toBe(true);
		// 🔴 Still true, and the reason this assertion survives the flip: a
		// sender-key recovery reads its own inbox and posts nothing at all.
		expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
	});

	it("renders the recovery report, naming the rung and who pays", async () => {
		// The recovery itself needs real MLS state on disk; what this asserts is
		// the wiring — the SDK's report reaches `describeMlsRecovery`, which is
		// the one place either language stack words a recovery.
		const client = {
			withAgent() {
				return this;
			},
			groups: {
				resolveRef: async () => resolvedGroup({ mls_enabled: true }),
				sync: async () => ({
					regime: "mls",
					rung: "resync",
					fromEpoch: 2,
					epoch: 13,
					behind: 11,
					processed: 0,
					evicted: false,
				}),
			},
			// biome-ignore lint/suspicious/noExplicitAny: structural fake.
		} as any;
		const out = await runTool(
			createRineGroupSyncTool({ ...opts(), client }),
			{ group: GROUP_ID },
			h,
		);
		expect(out).toContain("Resynced group");
		expect(out).toContain("O(N)");
		expect(out).toContain("every member of the group downloads");
	});
});

describe("an outstanding row reports where the vote stands", () => {
	/** One row through the real SDK parse, as the model would read it. */
	async function row(over: Record<string, unknown>): Promise<string> {
		h.route("GET", new RegExp(`^/groups/${GROUP_ID}/requests$`), () => ({
			json: { items: [requestRow(over)], next_cursor: null },
		}));
		return await runTool(
			createRineGroupRequestsTool(opts()),
			{ group: GROUP_ID, outstanding: "pending" },
			h,
		);
	}

	it("an eligible voter reads the arithmetic and that the vote counts", async () => {
		const out = await row({
			quorum_total_members: 9,
			electorate_size: 3,
			approvals: 1,
			denials: 0,
			approvals_needed: 1,
			denials_needed: 2,
			you_may_vote: true,
			you_may_vote_reason: "in_electorate",
		});
		// Character for character the Python twin's clause: both bars, one string,
		// on all four surfaces that render a request row. Through the real SDK
		// parse, so it also proves `denials_needed` survives the zod strip.
		expect(out).toContain(
			"1 approved, 1 more needed of 3 eligible; 0 denied, 2 more would refuse it",
		);
		expect(out).toContain("you can vote");
	});

	// The denial bar moves on its own — it falls as members leave, so a departure
	// can bring a standing denial within reach of a request nobody has voted on
	// since. A row that reports only the approval half cannot explain the refusal
	// that follows.
	it("a denial bar the server sent is printed beside the approval one", async () => {
		const out = await row({
			electorate_size: 4,
			approvals: 1,
			denials: 1,
			approvals_needed: 2,
			denials_needed: 1,
			you_may_vote: true,
			you_may_vote_reason: "in_electorate",
		});
		expect(out).toContain(
			"1 approved, 2 more needed of 4 eligible; 1 denied, 1 more would refuse it",
		);
	});

	it("a denial bar the server did not send is a dash, never a zero", async () => {
		// "no denials needed" and "this server does not report the denial bar" are
		// different facts, and only the first is arithmetic.
		const out = await row({
			electorate_size: 3,
			approvals: 1,
			denials: 0,
			approvals_needed: 1,
			you_may_vote: true,
			you_may_vote_reason: "in_electorate",
		});
		expect(out).toContain(
			"1 approved, 1 more needed of 3 eligible; 0 denied, — more would refuse it",
		);
		expect(out).not.toContain("0 more would refuse it");
	});

	it("drops the denial half entirely for a server that counts no denials", async () => {
		// The same rule the approval half already follows, one field down: a server
		// that reports approvals and no denials prints exactly the clause it
		// printed before this bar existed.
		const out = await row({
			electorate_size: 3,
			approvals: 1,
			approvals_needed: 1,
			you_may_vote: true,
			you_may_vote_reason: "in_electorate",
		});
		expect(out).toContain(
			"1 approved, 1 more needed of 3 eligible  you can vote",
		);
		expect(out).not.toContain("would refuse it");
		expect(out).not.toContain("denied");
	});

	// Both new tokens carry the frozen clause, so a row states the reason
	// rather than printing the wire token at a model.
	it("tells an applicant reading its own request that it is its own", async () => {
		const out = await row({
			electorate_size: 3,
			approvals: 0,
			denials: 0,
			approvals_needed: 2,
			denials_needed: 2,
			you_may_vote: false,
			you_may_vote_reason: "is_applicant",
		});
		expect(out).toContain("this is your own request");
		expect(out).not.toContain("`is_applicant`");
	});

	it("says a request with no recorded electorate is undecidable, not empty", async () => {
		// `electorate_empty` asserts a fact about a set nobody wrote. A row filed
		// before electorates existed, whose bar is zero, gets its own token.
		const out = await row({
			electorate_size: null,
			approvals: 0,
			denials: 0,
			approvals_needed: null,
			denials_needed: null,
			you_may_vote: false,
			you_may_vote_reason: "bar_unreachable",
		});
		expect(out).toContain("nobody can decide this request");
		expect(out).not.toContain("nobody eligible is still in the group");
		expect(out).not.toContain("`bar_unreachable`");
	});

	it("a latecomer is told the vote would not count, before spending a call", async () => {
		const out = await row({
			electorate_size: 3,
			approvals: 1,
			denials: 0,
			approvals_needed: 1,
			you_may_vote: false,
			you_may_vote_reason: "not_in_electorate",
		});
		expect(out).toContain(
			"you cannot vote: you were not in the group when this was filed",
		);
	});

	it("an emptied electorate reads as undecidable, with no counts to repeat it", async () => {
		const out = await row({
			electorate_size: 0,
			approvals: 0,
			denials: 0,
			approvals_needed: null,
			you_may_vote: false,
			you_may_vote_reason: "electorate_empty",
		});
		expect(out).toContain("nobody eligible is still in the group");
		expect(out).not.toContain("eligible  ");
	});

	it("a server that sends none of it falls back to any member may vote", async () => {
		// Production is one of these. The fields are absent from the wire and the
		// SDK schema's default supplies the rule that server actually applies —
		// zod STRIPS what it is not told about, so a row that reported nothing
		// here would be indistinguishable from one where nobody may vote.
		const out = await row({});
		expect(out).toContain("any member may");
		expect(out).not.toContain("more needed of");
		expect(out).not.toContain("undefined");
	});

	it("counts the server did send are printed even with no electorate size", async () => {
		// A 0016-era row: the tally is real and only the electorate is missing.
		// Dropping the whole clause here threw away numbers the server sent, and
		// the Python twin printed them — so the same row read differently
		// depending on which stack the operator happened to be holding.
		const out = await row({
			quorum_total_members: 5,
			electorate_size: null,
			approvals: 2,
			denials: 0,
			approvals_needed: 1,
			you_may_vote: true,
			you_may_vote_reason: "electorate_not_recorded",
		});
		expect(out).toContain("2 approved, 1 more needed of — eligible");
	});

	it("an agent that already voted is told which way", async () => {
		const out = await row({
			you_may_vote: false,
			you_may_vote_reason: "already_voted",
			your_vote: "approve",
		});
		expect(out).toContain("you already voted approve  expires");
	});

	it("an already-voted row that names no ballot dashes it", async () => {
		const out = await row({
			you_may_vote: false,
			you_may_vote_reason: "already_voted",
			your_vote: null,
		});
		expect(out).toContain("you already voted —  expires");
	});

	it("a decided request reads as closed to voting", async () => {
		const out = await row({
			status: "approved",
			you_may_vote: false,
			you_may_vote_reason: "not_pending",
		});
		expect(out).toContain("not open for voting");
	});

	it("a reason this package predates prints itself, never a guess", async () => {
		const out = await row({ you_may_vote_reason: "constructor" });
		expect(out).toContain("eligibility `constructor`  expires");
		expect(out).not.toContain("you can vote");
	});

	it("a row that never went through the SDK parse never prints `undefined`", () => {
		// The tool always parses, so the schema default fills the reason in; only a
		// row handed straight to the renderer can arrive without one.
		const out = renderRequests("g", "pending", [
			requestRow() as unknown as JoinRequestRead,
		]);
		expect(out).toContain("eligibility not reported");
		expect(out).not.toContain("undefined");
	});
});

describe("rine_group_vote refuses in words a model can act on", () => {
	/** The tool's output when the vote route answers `status` with `body`. */
	async function refused(status: number, body: unknown): Promise<string> {
		h.route(
			"POST",
			new RegExp(`^/groups/${GROUP_ID}/requests/${REQUEST_ID}/vote$`),
			() => ({ status, json: body }),
		);
		return await runTool(
			createRineGroupVoteTool(opts()),
			{ group: GROUP_ID, requestId: REQUEST_ID, vote: "approve" },
			h,
		);
	}

	it("says no vote was recorded and where to read who can decide", async () => {
		const out = await refused(403, {
			error: "not_in_electorate",
			detail:
				"This request is decided by the members this group had when it was filed, and you were not one of them.",
		});
		expect(out).toContain(`No vote was recorded in \`${GROUP_ID}\``);
		expect(out).toContain("you were not one of them");
		expect(out).toContain("Retrying will not help");
		// Never the bare authorization line: that reads as a fixable permission.
		expect(out).not.toContain("Not authorized");
	});

	it("says an emptied electorate leaves the request to its expiry", async () => {
		const out = await refused(403, {
			error: "electorate_empty",
			detail:
				"Nobody who was a member of this group when this request was filed is still in it.",
		});
		expect(out).toContain("No vote from anyone can decide this request");
		expect(out).toContain("until it expires");
	});

	// The refusal half of the same case. `SelfRequestVoteError` carries
	// `is_applicant`, and it is reachable exactly when an applicant was seated by
	// some other route while its own request still stands — an ordinary shape. A
	// bare "Not authorized" would read as a permission an operator can grant.
	it("says an agent cannot decide the request it is the subject of", async () => {
		const out = await refused(403, {
			error: "is_applicant",
			detail:
				"This is your own join request. The members this group had when it was filed decide it, and you were not one of them.",
		});
		expect(out).toContain(`No vote was recorded in \`${GROUP_ID}\``);
		expect(out).toContain("This is your own join request");
		expect(out).toContain("Retrying will not help");
		expect(out).not.toContain("Not authorized");
	});

	it("leaves every other refusal to the shared error formatter", async () => {
		// A deliberately neutral stand-in. What this asserts is PROPAGATION —
		// that a refusal this tool has no special sentence for reaches the model
		// as the shared formatter wrote it. The server's own group refusals now
		// name the acting agent and a seated sibling, so pinning one of those
		// strings here would make the fake state a product fact it does not own,
		// and would go stale the next time the server rewords it.
		const out = await refused(403, { detail: "stand-in refusal" });
		expect(out).toBe("Not authorized: stand-in refusal.");
	});
});

describe("rine_group_reclaim", () => {
	/**
	 * A client whose resume returns `admission`. The reclamation itself needs
	 * real MLS state on disk; what this asserts is the wiring — that the tool
	 * asks for a reclamation and returns the shared sentence rather than one of
	 * its own.
	 */
	function fakeClient(admission: unknown, seen: { opts?: unknown }) {
		return {
			withAgent() {
				return this;
			},
			groups: {
				resolveRef: async () => resolvedGroup({ mls_enabled: true }),
				resumeMlsAdmission: async (_group: unknown, o: unknown) => {
					seen.opts = o;
					return admission;
				},
			},
			// biome-ignore lint/suspicious/noExplicitAny: structural fake.
		} as any;
	}

	const admission = (reclamation?: unknown) => ({
		epoch: 12,
		commits: 2,
		added: 1,
		outcomes: [{ agentId: PEER_AGENT_ID, status: "added" }],
		reclamation,
	});

	it("asks the SDK to reclaim, not merely to seat", async () => {
		const seen: { opts?: unknown } = {};
		const out = await runTool(
			createRineGroupReclaimTool({
				...opts(),
				client: fakeClient(
					admission({ found: 2, reclaimed: 2, commits: 2, epoch: 12 }),
					seen,
				),
			}),
			{ group: GROUP_ID },
			h,
		);
		expect(seen.opts).toEqual({ reclaim: true });
		expect(out).toContain(`Seated 1 of 1 in 2 commit(s) in \`${GROUP_ID}\``);
		expect(out).toContain("Reclaimed 2 of 2 orphaned leaves");
		// The cost is the deterrent, so it is never left out of the report.
		expect(out).toContain("billed to every member");
	});

	it("says a clean tree is clean rather than saying nothing", async () => {
		const out = await runTool(
			createRineGroupReclaimTool({
				...opts(),
				client: fakeClient(
					admission({ found: 0, reclaimed: 0, commits: 0, epoch: 12 }),
					{},
				),
			}),
			{ group: GROUP_ID },
			h,
		);
		expect(out).toContain(
			"Every leaf belongs to a member or to an unanswered invitation.",
		);
	});

	it("returns the decline the pass reported, not a sentence of its own", async () => {
		const detail =
			"An agent this group calls a member holds no leaf in the ratchet tree.";
		const out = await runTool(
			createRineGroupReclaimTool({
				...opts(),
				client: fakeClient(
					admission({
						found: 0,
						reclaimed: 0,
						commits: 0,
						epoch: 12,
						declined: { reason: "identity_unseated", detail },
					}),
					{},
				),
			}),
			{ group: GROUP_ID },
			h,
		);
		expect(out).toContain(detail);
	});
});
