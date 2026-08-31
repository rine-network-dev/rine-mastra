/**
 * The structural guard: **mastra's acting agent comes from the operator, or
 * from nowhere.**
 *
 * `src/context.ts` states the rule this file defends — the actor is read from
 * `RequestContext`, NEVER from the model-visible `inputSchema`. `getRineClient`
 * builds a *bare* `AsyncRineClient` whenever `opts.agent` is falsy, so anything
 * ambient that the SDK picked up on its own would become the actor of every tool
 * in the toolkit, chosen by neither the operator nor the model. A
 * `RINE_AGENT` read inside `rine-ts-sdk` did exactly that once and was
 * reverted in full; this test fails if it returns.
 *
 * `RINE_ACTING_AGENT` (`src/context.ts`) is a RequestContext key, not an
 * environment variable, and is untouched by any of this.
 *
 * The wire, not the shape: the SDK's `agentHeader` is private, so these tests
 * drive a real request through a stubbed `fetch` and read the header that
 * actually left.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { _resetClientCache, getRineClient } from "../src/client.js";
import {
	RINE_API_URL as RINE_API_URL_KEY,
	RINE_CONFIG_DIR,
	type RineToolContext,
} from "../src/context.js";
import { createRineWhoamiTool } from "../src/discovery.js";
import {
	API_URL as HARNESS_API_URL,
	type Harness,
	makeHarness,
	runTool,
} from "./harness.js";

/** The wire name, spelled literally: importing the constant here would assert
 * it against itself and pass just as happily if it were renamed. */
const HEADER = "X-Rine-Agent";
const API_URL = "https://api.actor-env.test";

const SAVED_ENV = { ...process.env };
let configDir: string;
let calls: { url: string; init: RequestInit }[];

/** Answer the token POST and the `/agents` GET; record every request. */
function installFetchStub(): void {
	calls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
			const url = String(input);
			calls.push({ url, init });
			const body = url.includes("/oauth/token")
				? { access_token: "stub-token", expires_in: 3600 }
				: { items: [], total: 0 };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
}

/** The acting-agent header on the `/agents` call, case-insensitively. */
function sentActorHeader(): string | undefined {
	const call = calls.find((c) => c.url.includes("/agents"));
	const headers = (call?.init.headers ?? {}) as Record<string, string>;
	return Object.entries(headers).find(
		([k]) => k.toLowerCase() === HEADER.toLowerCase(),
	)?.[1];
}

beforeEach(() => {
	_resetClientCache();
	configDir = fs.mkdtempSync(join(tmpdir(), "rine-mastra-actor-env-"));
	fs.writeFileSync(
		join(configDir, "credentials.json"),
		JSON.stringify({ default: { client_id: "id", client_secret: "sec" } }),
	);
	process.env.RINE_AGENT = "kofi";
	installFetchStub();
});

afterEach(() => {
	_resetClientCache();
	process.env = { ...SAVED_ENV };
	fs.rmSync(configDir, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("mastra's actor is operator-fixed", () => {
	it("sends no acting-agent header when the operator named no agent", async () => {
		const client = getRineClient({ configDir, apiUrl: API_URL });

		await client.identity.listAgents();

		expect(sentActorHeader()).toBeUndefined();
	});

	it("sends the operator's agent when one was named — the falsifier for the test above", async () => {
		const client = getRineClient({ configDir, apiUrl: API_URL, agent: "bob" });

		await client.identity.listAgents();

		expect(sentActorHeader()).toBe("bob");
	});

	it("names RINE_AGENT nowhere in this package's own source", async () => {
		// The SDK is the near miss, but a well-meaning "convenience default" here
		// would re-open the same hole one layer up. Grep, because the absence of a
		// read is the property — there is no call to assert on.
		const { readdirSync, readFileSync, statSync } = fs;
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((e) => {
				const p = join(dir, e);
				return statSync(p).isDirectory()
					? walk(p)
					: p.endsWith(".ts")
						? [p]
						: [];
			});
		const offenders = walk(new URL("../src", import.meta.url).pathname).filter(
			(p) => readFileSync(p, "utf-8").includes("RINE_AGENT"),
		);
		expect(offenders).toEqual([]);
	});

	it("imports no environment reader from core", async () => {
		// The literal grep above misses the obvious next edit: `agent:
		// opts.agent ?? actorFromEnv()` adds no occurrence of the string
		// `RINE_AGENT` to this package at all. The *symbols* are the seam —
		// core's env read has exactly two names, and neither may be imported
		// here.
		const { readdirSync, readFileSync, statSync } = fs;
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((e) => {
				const p = join(dir, e);
				return statSync(p).isDirectory()
					? walk(p)
					: p.endsWith(".ts")
						? [p]
						: [];
			});
		const offenders = walk(new URL("../src", import.meta.url).pathname).filter(
			(p) => /\bactorFromEnv\b|\bACTING_AGENT_ENV\b/.test(readFileSync(p, "utf-8")),
		);
		expect(offenders).toEqual([]);
	});
});

/**
 * The same property, driven rather than read: a real tool's `execute`, with
 * `RINE_AGENT` exported and nothing else naming an agent.
 *
 * The three tests above stop at `getRineClient`. A default added one layer up —
 * in a tool factory or in `toolkit.ts`, where `opts` is assembled before
 * `getRineClient` ever sees it — passes all three and still re-actors every
 * call. This one reads the header off the wire at the end of the real path.
 */
describe("a tool's execute inherits nothing from the environment", () => {
	let h: Harness;

	beforeEach(() => {
		h = makeHarness();
		h.route("GET", /^\/org$/, () => ({
			json: {
				id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				name: "Acme",
				slug: "acme",
				trust_tier: 2,
				created_at: "2026-06-01T00:00:00.000Z",
			},
		}));
	});
	afterEach(() => h.cleanup());

	/** The harness ctx names an acting agent; this one deliberately does not. */
	function ctxWithoutActor(): RineToolContext {
		const rc = new RequestContext();
		rc.set(RINE_CONFIG_DIR, h.configDir);
		rc.set(RINE_API_URL_KEY, HARNESS_API_URL);
		return { requestContext: rc };
	}

	const actorHeaders = (): (string | undefined)[] =>
		h.requests.map((r) => r.headers["x-rine-agent"]).filter((v) => v !== undefined);

	it("sends no acting-agent header on any request the tool makes", async () => {
		const tool = createRineWhoamiTool({});

		await runTool(tool, {}, h, ctxWithoutActor());

		expect(h.requests.length).toBeGreaterThan(0);
		expect(actorHeaders()).toEqual([]);
	});

	it("sends the operator's agent when the toolkit named one — the falsifier", async () => {
		const tool = createRineWhoamiTool({ agent: "bob" });

		await runTool(tool, {}, h, ctxWithoutActor());

		expect(actorHeaders()).toContain("bob");
	});
});
