/**
 * `rineToolkit` aggregator (AC-10 include filter, AC-11 shared client).
 *
 * The toolkit builds no socket (I-1 — `getRineClient` only stashes config), so
 * these run without a mock fetch: they inspect the returned record's keys and
 * that all tools close over ONE shared client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClientCache } from "../src/client.js";
import * as clientModule from "../src/client.js";
import { rineToolkit } from "../src/tools.js";

const ALL_IDS = [
	"rine_send",
	"rine_send_and_wait",
	"rine_check_inbox",
	"rine_read",
	"rine_reply",
	"rine_discover",
	"rine_inspect",
	"rine_group_create",
	"rine_group_invite",
	"rine_group_remove",
	"rine_group_inspect",
].sort();

const MESSAGING_IDS = [
	"rine_send",
	"rine_send_and_wait",
	"rine_check_inbox",
	"rine_read",
	"rine_reply",
].sort();

const OPTS = { configDir: "/tmp/toolkit-test", apiUrl: "https://x.test" };

beforeEach(() => {
	_resetClientCache();
});
afterEach(() => {
	_resetClientCache();
	vi.restoreAllMocks();
});

describe("rineToolkit — AC-10 include filter (keys === ids)", () => {
	it("default returns all 11 tools, each keyed by its id", () => {
		const kit = rineToolkit(OPTS);
		expect(Object.keys(kit).sort()).toEqual(ALL_IDS);
		// The KEY equals the tool's own id (toolName === id).
		for (const [key, tool] of Object.entries(kit)) {
			expect(tool.id).toBe(key);
		}
	});

	it("include:'messaging' returns exactly the 5 messaging tools", () => {
		const kit = rineToolkit({ ...OPTS, include: "messaging" });
		expect(Object.keys(kit).sort()).toEqual(MESSAGING_IDS);
	});

	it("include:'discovery' returns exactly the 2 discovery tools", () => {
		const kit = rineToolkit({ ...OPTS, include: "discovery" });
		expect(Object.keys(kit).sort()).toEqual(
			["rine_discover", "rine_inspect"].sort(),
		);
	});

	it("an array value returns the union of the named domains", () => {
		const kit = rineToolkit({ ...OPTS, include: ["discovery", "groups"] });
		expect(Object.keys(kit).sort()).toEqual(
			[
				"rine_discover",
				"rine_inspect",
				"rine_group_create",
				"rine_group_invite",
				"rine_group_remove",
				"rine_group_inspect",
			].sort(),
		);
		// Messaging is excluded.
		expect(kit.rine_send).toBeUndefined();
	});

	it("include:'all' is equivalent to the default", () => {
		expect(
			Object.keys(rineToolkit({ ...OPTS, include: "all" })).sort(),
		).toEqual(ALL_IDS);
	});
});

describe("rineToolkit — AC-11 one shared client per call", () => {
	it("builds exactly ONE client for the whole toolkit", () => {
		const spy = vi.spyOn(clientModule, "getRineClient");
		rineToolkit(OPTS);
		// One shared client is built per rineToolkit() call (not one per tool).
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith({
			configDir: OPTS.configDir,
			apiUrl: OPTS.apiUrl,
			agent: undefined,
		});
	});

	it("propagates the agent override into the shared client build", () => {
		const spy = vi.spyOn(clientModule, "getRineClient");
		rineToolkit({ ...OPTS, agent: "support" });
		expect(spy).toHaveBeenCalledWith({
			configDir: OPTS.configDir,
			apiUrl: OPTS.apiUrl,
			agent: "support",
		});
	});
});
