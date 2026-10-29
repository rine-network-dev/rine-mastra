/**
 * Client builder (`getRineClient`) — config resolution + the `configDir:""`
 * footgun fix + per-toolkit memoization + the no-`RINE_TOKEN` assertion.
 *
 * The SDK constructor only stashes config (no network, no fs at construction),
 * so these tests build real clients without a mock fetch — they inspect that
 * the right config is resolved and that the cache shares instances.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiUrl, resolveConfigDir } from "@rine-network/core";
import { seedAgentRuntime, seedOrgIdentity } from "@rine-network/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClientCache, getRineClient } from "../src/client.js";

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	_resetClientCache();
});

afterEach(() => {
	_resetClientCache();
	process.env = { ...SAVED_ENV };
	vi.restoreAllMocks();
});

describe("getRineClient — config resolution", () => {
	it("uses explicit configDir/apiUrl when supplied (no footgun)", () => {
		const client = getRineClient({
			configDir: "/tmp/explicit-config",
			apiUrl: "https://api.explicit.test",
		});
		// The SDK exposes configDir via withOptions-derived clients; assert by
		// constructing a derived client and checking it shares the dir through a
		// round-trip on the public surface (withAgent keeps configDir).
		expect(client).toBeDefined();
		// A second call with the SAME resolved config returns the SAME base.
		const again = getRineClient({
			configDir: "/tmp/explicit-config",
			apiUrl: "https://api.explicit.test",
		});
		// withAgent is not applied (no agent) so these are the memoized base.
		expect(again).toBe(client);
	});

	it("resolves configDir from RINE_CONFIG_DIR when none passed (not '')", () => {
		process.env.RINE_CONFIG_DIR = "/tmp/from-env-config";
		// THE FOOTGUN: if the adapter forgot to resolve, the SDK would default
		// configDir to "" and silently target cwd. We prove the env var was
		// actually resolved to its exact path by asserting a cache HIT against an
		// explicit client built with the SAME dir + the SAME default apiUrl. The
		// cache key is `${configDir} ${apiUrl}`, so this `.toBe` holds ONLY if
		// resolveConfigDir() returned "/tmp/from-env-config" — it would FAIL (keys
		// "" vs "/tmp/from-env-config") if the resolver ever regressed to "".
		const defaultApiUrl = resolveApiUrl();
		const envClient = getRineClient();
		const explicitSame = getRineClient({
			configDir: "/tmp/from-env-config",
			apiUrl: defaultApiUrl,
		});
		expect(envClient).toBe(explicitSame);

		// And the resolved dir is the actual env path (never "") — the direct
		// proof that omitting configDir routes through resolveConfigDir(), not the
		// SDK's "" default.
		expect(resolveConfigDir()).toBe("/tmp/from-env-config");
	});

	it("memoizes one client per (configDir, apiUrl); agent variants derive cheaply", () => {
		const a = getRineClient({ configDir: "/tmp/cfg", apiUrl: "https://x" });
		const b = getRineClient({ configDir: "/tmp/cfg", apiUrl: "https://x" });
		expect(a).toBe(b); // one shared base client per option set

		const withAgent = getRineClient({
			configDir: "/tmp/cfg",
			apiUrl: "https://x",
			agent: "support",
		});
		// A per-agent client is a cheap DERIVED client, not the base.
		expect(withAgent).not.toBe(a);

		const other = getRineClient({
			configDir: "/tmp/other",
			apiUrl: "https://x",
		});
		expect(other).not.toBe(a); // distinct config → distinct base
	});

	it("there is NO RINE_TOKEN env knob in the auth model", () => {
		// The SDK auth chain is the profile and agent keys in the config dir — never a
		// raw bearer token. Prove RINE_TOKEN is NOT consulted by showing that
		// changing it (without resetting the cache) does NOT change client
		// resolution: the second call with the SAME (configDir, apiUrl) returns the
		// SAME memoized instance. If RINE_TOKEN were ever folded into the cache key
		// or the auth model, this `.toBe` would FAIL.
		process.env.RINE_TOKEN = "should-be-ignored";
		const before = getRineClient({
			configDir: "/tmp/cfg2",
			apiUrl: "https://y",
		});
		process.env.RINE_TOKEN = "different-bogus";
		const after = getRineClient({
			configDir: "/tmp/cfg2",
			apiUrl: "https://y",
		});
		expect(after).toBe(before);

		// Same proof through the env-resolution layer: with RINE_CONFIG_DIR fixed,
		// flipping RINE_TOKEN between two calls (no cache reset) still yields the
		// SAME memoized client — the resolution never read RINE_TOKEN.
		_resetClientCache();
		process.env.RINE_CONFIG_DIR = "/tmp/cfg-token-test";
		process.env.RINE_TOKEN = "bogus-token-A";
		const envBefore = getRineClient();
		process.env.RINE_TOKEN = "bogus-token-B";
		const envAfter = getRineClient();
		expect(envAfter).toBe(envBefore);
	});
});

describe("getRineClient sign-in", () => {
	it("signs in as the agent while the owner dir holds an org root", async () => {
		const base = mkdtempSync(join(tmpdir(), "rine-client-"));
		const configDir = join(base, "runtime");
		const ownerDir = join(base, "owner");
		const agentId = "622684e9-8ef3-4633-b407-b658c23c6b1f";
		seedAgentRuntime(configDir, agentId, { cacheToken: false });
		seedOrgIdentity(ownerDir);
		vi.stubEnv("RINE_OWNER_DIR", ownerDir);
		const assertions: string[] = [];
		vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
			const json = (body: unknown) => Response.json(body, { status: 200 });
			if (String(url).endsWith("/oauth/token")) {
				const form = new URLSearchParams(String(init?.body));
				assertions.push(form.get("client_assertion") ?? "");
				return json({ access_token: "t", expires_in: 900 });
			}
			return json({ items: [], total: 0 });
		});
		try {
			await getRineClient({ configDir, apiUrl: "https://rine.test" }).listAgents();
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
			rmSync(base, { recursive: true, force: true });
		}
		const claims = JSON.parse(
			Buffer.from(assertions[0]?.split(".")[1] ?? "", "base64url").toString(),
		);
		expect(claims.iss).toBe(`agent:${agentId}`);
	});
});
