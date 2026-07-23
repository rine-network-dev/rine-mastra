/**
 * The out-of-band onboard CLI (`npx @rine-network/mastra onboard`).
 *
 * Two angles:
 *   1. `parseOnboardArgs` — pure arg parsing (required flags, unknown flags,
 *      optional overrides). NO real PoW.
 *   2. `runOnboard` / `main` — the orchestration, with the PoW/register +
 *      createAgent boundary MOCKED at the `@rine-network/sdk` module edge so the
 *      test never runs a real ~30–60 s proof-of-work. Asserts: register is called
 *      with resolved apiUrl/configDir + progress is wired; createAgent is called;
 *      the handle + verification words are printed; `main` routes the subcommand
 *      and exits non-zero on a parse error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.fn();
const createAgent = vi.fn();

vi.mock("@rine-network/sdk", () => ({
	register,
	AsyncRineClient: class {
		createAgent = createAgent;
	},
}));

// Imported AFTER the mock is registered so onboard.ts binds the mocked symbols.
const { agentNameFromOrgName, main, parseOnboardArgs, runOnboard } =
	await import("../src/onboard.js");

/** Collect printed lines instead of writing to stdout. */
function makeIO() {
	const lines: string[] = [];
	return { io: { log: (l: string) => lines.push(l) }, lines };
}

beforeEach(() => {
	register.mockReset();
	createAgent.mockReset();
	register.mockResolvedValue({ orgId: "org-1", clientId: "cid-1" });
	createAgent.mockResolvedValue({
		handle: "support@acme.rine.network",
		name: "Support",
		verification_words: "tiger maple ridge",
	});
});
afterEach(() => {
	vi.clearAllMocks();
	process.exitCode = 0;
});

describe("parseOnboardArgs", () => {
	it("parses the three required flags", () => {
		const args = parseOnboardArgs([
			"--email",
			"a@b.co",
			"--slug",
			"acme",
			"--name",
			"Acme",
		]);
		expect(args).toEqual({
			email: "a@b.co",
			slug: "acme",
			name: "Acme",
			apiUrl: undefined,
			configDir: undefined,
			agentName: undefined,
		});
	});

	it("parses the optional --agent-name override", () => {
		const args = parseOnboardArgs([
			"--email",
			"a@b.co",
			"--slug",
			"acme",
			"--name",
			"Acme Inc",
			"--agent-name",
			"coordinator",
		]);
		expect(args.agentName).toBe("coordinator");
	});

	it("parses the optional --api-url and --config-dir overrides", () => {
		const args = parseOnboardArgs([
			"--email",
			"a@b.co",
			"--slug",
			"acme",
			"--name",
			"Acme",
			"--api-url",
			"https://test.rine",
			"--config-dir",
			"/tmp/cfg",
		]);
		expect(args.apiUrl).toBe("https://test.rine");
		expect(args.configDir).toBe("/tmp/cfg");
	});

	it("throws on a missing required flag", () => {
		expect(() =>
			parseOnboardArgs(["--email", "a@b.co", "--slug", "acme"]),
		).toThrow(/Missing required flag\(s\): --name/);
	});

	it("throws on an unknown flag", () => {
		expect(() =>
			parseOnboardArgs([
				"--email",
				"a@b.co",
				"--slug",
				"acme",
				"--name",
				"Acme",
				"--bogus",
				"x",
			]),
		).toThrow(/Unknown flag: --bogus/);
	});

	it("throws on a flag with no value", () => {
		expect(() => parseOnboardArgs(["--email"])).toThrow(
			/Missing value for --email/,
		);
	});

	it("throws on a non-flag positional argument", () => {
		expect(() => parseOnboardArgs(["onboard", "--email", "a@b.co"])).toThrow(
			/Unexpected argument: onboard/,
		);
	});
});

describe("agentNameFromOrgName — handle-safe derivation (regression: server 422 on display names)", () => {
	it("lowercases and hyphenates a spaced display name", () => {
		expect(agentNameFromOrgName("My Org", "my-org-slug")).toBe("my-org");
		expect(agentNameFromOrgName("E2E Driver", "drv")).toBe("e2e-driver");
	});

	it("folds runs of specials to a single interior hyphen and trims edges", () => {
		expect(agentNameFromOrgName("  Acme,  Inc!! ", "acme")).toBe("acme-inc");
		expect(agentNameFromOrgName("a@@@b", "fallback")).toBe("a-b");
	});

	it("falls back to the slug when nothing usable remains", () => {
		expect(agentNameFromOrgName("---", "acme")).toBe("acme");
		expect(agentNameFromOrgName("！！！", "acme")).toBe("acme");
	});

	it("only ever yields a server-valid agent name (1–200 lowercase alnum + interior hyphens)", () => {
		const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
		for (const [name, slug] of [
			["My Org", "s1"],
			["E2E Driver", "s2"],
			["Acme, Inc.", "s3"],
			["x", "s4"],
		] as const) {
			const derived = agentNameFromOrgName(name, slug);
			expect(derived).toMatch(valid);
			expect(derived.length).toBeGreaterThanOrEqual(1);
			expect(derived.length).toBeLessThanOrEqual(200);
		}
	});
});

describe("runOnboard — orchestration (PoW/register boundary mocked)", () => {
	it("registers with explicit overrides, creates the agent, prints handle + words", async () => {
		const { io, lines } = makeIO();
		const handle = await runOnboard(
			{
				email: "a@b.co",
				slug: "acme",
				name: "Support",
				apiUrl: "https://test.rine",
				configDir: "/tmp/cfg",
			},
			io,
		);

		expect(handle).toBe("support@acme.rine.network");

		// register() got the resolved overrides + a progress callback.
		expect(register).toHaveBeenCalledTimes(1);
		const regArg = register.mock.calls[0]?.[0];
		expect(regArg).toMatchObject({
			email: "a@b.co",
			slug: "acme",
			name: "Support",
			apiUrl: "https://test.rine",
			configDir: "/tmp/cfg",
		});
		expect(typeof regArg.onProgress).toBe("function");

		// createAgent ran with the handle-safe name DERIVED from the display name
		// ("Support" → "support") — the server rejects uppercase/spaces.
		expect(createAgent).toHaveBeenCalledWith("support");

		// The handle + verification words reached stdout.
		const out = lines.join("\n");
		expect(out).toContain("Agent ready: support@acme.rine.network");
		expect(out).toContain("Verification words: tiger maple ridge");
	});

	it("derives a handle-safe agent name from a free-form display name (regression)", async () => {
		const { io } = makeIO();
		await runOnboard(
			{
				email: "a@b.co",
				slug: "my-org",
				name: "My Org",
				configDir: "/tmp/cfg",
			},
			io,
		);
		// The org display name ("My Org") is NOT a valid agent name; the first
		// agent is created with the derived handle-safe form, while register()
		// still receives the human display name.
		expect(createAgent).toHaveBeenCalledWith("my-org");
		expect(register.mock.calls[0]?.[0]).toMatchObject({ name: "My Org" });
	});

	it("uses an explicit agentName override verbatim", async () => {
		const { io } = makeIO();
		await runOnboard(
			{
				email: "a@b.co",
				slug: "acme",
				name: "Acme Inc",
				agentName: "coordinator",
				configDir: "/tmp/cfg",
			},
			io,
		);
		expect(createAgent).toHaveBeenCalledWith("coordinator");
	});

	it("forwards progress percentages to the IO as whole-percent lines", async () => {
		register.mockImplementation(
			async (opts: { onProgress?: (p: number) => void }) => {
				opts.onProgress?.(0);
				opts.onProgress?.(49.7);
				opts.onProgress?.(100);
				return { orgId: "o", clientId: "c" };
			},
		);
		const { io, lines } = makeIO();
		await runOnboard(
			{ email: "a@b.co", slug: "acme", name: "Support", configDir: "/tmp/cfg" },
			io,
		);
		const out = lines.join("\n");
		expect(out).toContain("proof-of-work 0%");
		expect(out).toContain("proof-of-work 49%");
		expect(out).toContain("proof-of-work 100%");
	});

	it("omits the verification-words line when the server returns none", async () => {
		createAgent.mockResolvedValue({
			handle: "support@acme.rine.network",
			name: "Support",
			verification_words: null,
		});
		const { io, lines } = makeIO();
		await runOnboard(
			{ email: "a@b.co", slug: "acme", name: "Support", configDir: "/tmp/cfg" },
			io,
		);
		expect(lines.join("\n")).not.toContain("Verification words:");
	});
});

describe("main — subcommand routing + exit codes", () => {
	it("runs the onboard flow for a valid `onboard` invocation", async () => {
		const { io } = makeIO();
		await main(
			[
				"onboard",
				"--email",
				"a@b.co",
				"--slug",
				"acme",
				"--name",
				"Support",
				"--config-dir",
				"/tmp/cfg",
			],
			io,
		);
		expect(register).toHaveBeenCalledTimes(1);
		expect(process.exitCode).not.toBe(1);
	});

	it("prints usage + exits 1 on an unknown subcommand", async () => {
		const { io, lines } = makeIO();
		await main(["nonsense"], io);
		expect(register).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(lines.join("\n")).toContain("Usage:");
	});

	it("prints the parse error + usage + exits 1 on a bad flag set", async () => {
		const { io, lines } = makeIO();
		await main(["onboard", "--email", "a@b.co"], io);
		expect(register).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		const out = lines.join("\n");
		expect(out).toContain("Missing required flag");
		expect(out).toContain("Usage:");
	});
});
