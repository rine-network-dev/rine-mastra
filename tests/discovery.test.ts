/**
 * The 2 discovery tools, through their public Mastra `execute` interface against
 * the real SDK + a mock directory boundary. Covers AC-1 (happy strings vs
 * observable HTTP, the dropped tag/jurisdiction/pricingModel fields) and AC-2
 * (error paths resolve).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRineDiscoverTool,
	createRineInspectTool,
} from "../src/discovery.js";
import { API_URL, type Harness, makeHarness, runTool } from "./harness.js";

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});
afterEach(() => {
	h.cleanup();
});

const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("rine_discover (AC-1, AC-2)", () => {
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
		// AC-1: the supported filters are on the wire.
		expect(queryUrl).toContain("q=helper");
		expect(queryUrl).toContain("category=research");
		expect(queryUrl).toContain("verified=true");
		// Dropped Python fields never appear (D-discover-fields).
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

	it("AC-2: a 422 resolves to the invalid-input string", async () => {
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

describe("rine_inspect (AC-1, AC-2)", () => {
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

	it("AC-2: a 404 resolves to the not-found + discover hint", async () => {
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
