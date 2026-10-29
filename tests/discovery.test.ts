/**
 * The discovery tools, through their public Mastra `execute` interface against
 * the real SDK + a mock directory boundary. Covers the happy strings against
 * the observable HTTP (incl. the dropped tag/jurisdiction/pricingModel fields)
 * and the error paths, which resolve a readable string rather than reject.
 *
 * `rine_discover_groups` is registered in this domain but implemented with the
 * other group readers, so its tests live in `groups-list.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRineDiscoverTool,
	createRineInspectTool,
	createRineWhoamiTool,
} from "../src/discovery.js";
import { API_URL, type Harness, makeHarness, runTool } from "./harness.js";
import { FIXTURE_ORG_ID } from "@rine-network/core/testing";

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});
afterEach(() => {
	h.cleanup();
});

const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("rine_discover", () => {
	it("returns a numbered list and only sends the supported filter fields", async () => {
		let queryUrl = "";
		h.route("GET", /^\/directory\/agents$/, (req) => {
			queryUrl = req.url;
			return {
				json: {
					items: [
						{ id: A1, name: "Alice", handle: "alice@acme", verified: true },
						{
							id: A2,
							name: "Bob",
							handle: "bob@acme",
							verified: false,
							category: "research",
						},
					],
					total: 2,
					next_cursor: null,
					prev_cursor: null,
				},
			};
		});

		const tool = createRineDiscoverTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(
			tool,
			{ q: "helper", category: "research", verified: true, limit: 10 },
			h,
		);

		expect(out).toContain("1. alice@acme [verified]");
		expect(out).toContain("2. bob@acme (research)");
		// The supported filters are on the wire.
		expect(queryUrl).toContain("q=helper");
		expect(queryUrl).toContain("category=research");
		expect(queryUrl).toContain("verified=true");
		// Dropped Python fields never appear.
		expect(queryUrl).not.toContain("tag=");
		expect(queryUrl).not.toContain("jurisdiction=");
		expect(queryUrl).not.toContain("pricing");
	});

	it("empty result → 'No agents matched.'", async () => {
		h.route("GET", /^\/directory\/agents$/, () => ({
			json: { items: [], total: 0, next_cursor: null, prev_cursor: null },
		}));
		const tool = createRineDiscoverTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { limit: 10 }, h);
		expect(out).toBe("No agents matched.");
	});

	it("a 422 resolves to the invalid-input string", async () => {
		h.route("GET", /^\/directory\/agents$/, () => ({
			status: 422,
			json: { detail: "bad filter" },
		}));
		const tool = createRineDiscoverTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { limit: 10 }, h);
		expect(out).toBe("Invalid input: bad filter.");
	});
});

describe("rine_inspect", () => {
	it("returns the full profile render for a UUID (no WebFinger round-trip)", async () => {
		h.route("GET", new RegExp(`^/directory/agents/${A1}$`), () => ({
			json: {
				id: A1,
				name: "Alice",
				handle: "alice@acme",
				description: "a research agent",
				category: "research",
				verified: true,
				human_oversight: false,
			},
		}));
		const tool = createRineInspectTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { handleOrId: A1 }, h);

		expect(out).toContain("Alice (alice@acme)");
		expect(out).toContain("verified: yes");
		expect(out).toContain("human oversight: no");
		expect(out).toContain("description: a research agent");
	});

	it("a 404 resolves to the not-found + discover hint", async () => {
		h.route("GET", new RegExp(`^/directory/agents/${A1}$`), () => ({
			status: 404,
			json: { detail: "unknown agent" },
		}));
		const tool = createRineInspectTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, { handleOrId: A1 }, h);
		expect(out).toContain("Not found: unknown agent");
		expect(out).toContain("Try rine_discover");
	});
});

describe("rine_whoami", () => {
	it("renders the org, tier and live handles, dropping revoked agents", async () => {
		h.route("GET", /^\/whoami$/, () => ({
			json: {
				org: {
					id: FIXTURE_ORG_ID,
					name: "Acme",
					slug: "acme",
					trust_tier: 2,
					created_at: "2026-06-01T00:00:00.000Z",
				},
				principal: { kind: "agent", branch: "main", agent_id: A1 },
				agents: [
					{
						id: A1,
						name: "support",
						handle: "support@acme",
						created_at: "2026-06-01T00:00:00.000Z",
					},
					{
						id: A2,
						name: "retired",
						handle: "retired@acme",
						created_at: "2026-06-01T00:00:00.000Z",
						revoked_at: "2026-07-01T00:00:00.000Z",
					},
				],
			},
		}));

		const tool = createRineWhoamiTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});
		const out = await runTool(tool, {}, h);

		expect(out).toContain("Org Acme (acme)");
		expect(out).toContain("trust tier: 2");
		expect(out).toContain("support@acme");
		// A revoked agent is a handle nothing can be sent from or to.
		expect(out).not.toContain("retired@acme");
	});
});
