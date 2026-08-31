import { describe, expect, it } from "vitest";
import {
	renderAdmission,
	renderMlsAdmission,
	renderSingularInvite,
} from "../src/groups-admission.js";

// What a model is told about an admission, in rine's words rather
// than the server's wire tokens. The maps themselves are `rine-core`'s and are
// gated there; what these assert is that this surface uses them, and that the
// two vocabularies stay apart — an invitation is not a leaf.

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

describe("renderAdmission — the invitation, per agent", () => {
	it("says why a skip was skipped instead of naming the wire token", () => {
		const out = renderAdmission({
			invited: 1,
			skipped: 1,
			entries: [
				{ agent_id: ANA, status: "invited" },
				{ agent_id: BEN, status: "skipped", reason: "agent_revoked" },
			],
		});

		expect(out).toContain("1 of 2 reached; 1 new invitation to accept.");
		expect(out).toContain(`  ${ANA}: invited`);
		expect(out).toContain("identity is revoked");
		expect(out).not.toContain("(agent_revoked)");
	});

	// The urgent one: an open group mints no voucher because it needs none, and
	// `skipped (not_applicable)` read as a refusal to exactly the caller who was
	// being told the agent may walk in.
	it("does not report an open group's admission as a refusal", () => {
		const out = renderAdmission({
			invited: 0,
			skipped: 1,
			entries: [{ agent_id: ANA, status: "skipped", reason: "not_applicable" }],
		});

		expect(out).toContain("open enrollment");
		expect(out).toContain("may join whenever it likes");
		expect(out).not.toContain("(not_applicable)");
	});

	// The sharpest thing this surface can get wrong about a nomination
	// is to call it an invitation: an invitation is accepted, a nomination waits
	// on a vote that may refuse it, and a model told the first will report an
	// agent as good as in.
	it("never offers a nomination as an invitation to accept", () => {
		const out = renderAdmission({
			invited: 0,
			skipped: 0,
			entries: [{ agent_id: ANA, status: "nominated" }],
		});

		expect(out).toContain("1 of 1 reached; 1 new nomination awaiting a vote.");
		expect(out).toContain(`  ${ANA}: nominated, awaiting a vote`);
		expect(out).not.toContain("invitation to accept");
		expect(out).not.toContain(`${ANA}: invited`);
	});

	it("states both clauses when one batch produced both, invitations first", () => {
		const out = renderAdmission({
			invited: 1,
			skipped: 0,
			entries: [
				{ agent_id: ANA, status: "invited" },
				{ agent_id: BEN, status: "nominated" },
			],
		});

		expect(out).toContain(
			"2 of 2 reached; 1 new invitation to accept; 1 new nomination awaiting a vote.",
		);
	});

	it("quotes back a reason this client does not know rather than throwing", () => {
		const out = renderAdmission({
			invited: 0,
			skipped: 1,
			entries: [
				{
					agent_id: ANA,
					// A reason a later server may add; an older client must still render.
					status: "skipped",
					reason: "seat_ceiling_reached" as never,
				},
			],
		});

		expect(out).toContain("seat_ceiling_reached");
	});
});

describe("renderMlsAdmission — the ratchet-tree leaf, per agent", () => {
	it("names each agent that got no leaf, and why, in the leaf's vocabulary", () => {
		const out = renderMlsAdmission({
			epoch: 4,
			commits: 1,
			added: 1,
			outcomes: [
				{ agentId: ANA, status: "added" },
				{ agentId: BEN, status: "skipped", reason: "no_key_package" },
			],
		});

		expect(out).toContain("1 seated across 1 commit(s), group now at epoch 4.");
		expect(out).toContain(`${BEN}: published no key package`);
		expect(out).toContain("cannot read this group until a leaf exists");
	});

	// A resumed admission with nothing left to do is not a failure to report.
	it("says nothing about an agent that already holds a leaf", () => {
		const out = renderMlsAdmission({
			epoch: 4,
			commits: 0,
			added: 0,
			outcomes: [
				{ agentId: ANA, status: "skipped", reason: "already_in_group" },
			],
		});

		expect(out).not.toContain("No ratchet-tree leaf yet");
	});
});

// The singular route answers one row, so the status word is the only
// thing the tool has to tell an invitation from a nomination — and `Invited X
// (status pending)` said both at once.
describe("renderSingularInvite — one agent, one status word", () => {
	it("names an invitation as one, and says what it holds", () => {
		const out = renderSingularInvite(ANA, "#ops@acme", "invited");

		expect(out).toBe(
			`Invited ${ANA} to #ops@acme. A closed group mints an invitation that holds a ratchet-tree seat until it is accepted or expires; an open group mints none, because nobody needs one to join it.`,
		);
	});

	it("never calls a nomination an invitation, and says who decides it", () => {
		const out = renderSingularInvite(ANA, "#ops@acme", "pending");

		expect(out).toContain(`Nominated ${ANA} into #ops@acme.`);
		expect(out).toContain("the group's electorate decides");
		expect(out).toContain("nobody is seated until the vote carries");
		expect(out).not.toContain(`Invited ${ANA}`);
		expect(out).not.toContain("(status pending)");
	});

	it("prints a status it has never seen rather than reading it as one of these", () => {
		const out = renderSingularInvite(ANA, "#ops@acme", "reconsidered");

		expect(out).toBe(`Invited ${ANA} to #ops@acme (status reconsidered).`);
	});
});
