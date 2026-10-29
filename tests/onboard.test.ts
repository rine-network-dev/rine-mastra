/**
 * `npx @rine-network/mastra onboard` — the Mastra wrapper over the SDK's shared flow.
 *
 * The flow's behaviour (registration, the words it prints, argument parsing) is
 * covered where it lives, in `@rine-network/sdk` (including how a bad flag set is reported). What belongs here is the part
 * this package owns: the closing line, the subcommand routing in `main` and its
 * exit codes. The flow is stubbed at the SDK module edge, so no proof-of-work runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runOnboardFlow = vi.fn();
const runOnboardCli = vi.fn();

vi.mock("@rine-network/sdk", async (importOriginal) => ({
	...(await importOriginal<typeof import("@rine-network/sdk")>()),
	runOnboardFlow,
	runOnboardCli,
}));

const { main, runOnboard } = await import("../src/onboard.js");

const OPTS = { email: "a@b.co", slug: "acme", name: "Support" };

/** Collect printed lines instead of writing to stdout. */
function makeIO() {
	const lines: string[] = [];
	return { io: { log: (l: string) => lines.push(l) }, lines };
}

beforeEach(() => {
	runOnboardFlow.mockReset();
	runOnboardFlow.mockResolvedValue("support@acme.rine.network");
	runOnboardCli.mockReset();
});

afterEach(() => {
	process.exitCode = 0;
});

describe("runOnboard", () => {
	it("runs the shared flow with the Mastra closing line and returns the handle", async () => {
		const { io } = makeIO();
		const handle = await runOnboard(OPTS, io);

		expect(handle).toBe("support@acme.rine.network");
		const [opts, closing, flowIo] = runOnboardFlow.mock.calls[0] ?? [];
		expect(opts).toEqual(OPTS);
		expect(flowIo).toBe(io);
		expect((closing as string[]).join("\n")).toContain("RINE_CONFIG_DIR");
	});
});

describe("main — subcommand routing + exit codes", () => {
	it("hands the args after the subcommand to the shared CLI with the Mastra closing line", async () => {
		const { io } = makeIO();
		const args = ["--email", "a@b.co", "--slug", "acme", "--name", "Support"];
		await main(["onboard", ...args], io);
		const [connector, argv, closing, cliIo] = runOnboardCli.mock.calls[0] ?? [];
		expect(runOnboardCli).toHaveBeenCalledTimes(1);
		expect(connector).toBe("mastra");
		expect(argv).toEqual(args);
		expect(cliIo).toBe(io);
		expect((closing as string[]).join("\n")).toContain("RINE_CONFIG_DIR");
	});

	it("prints usage + exits 1 on an unknown subcommand", async () => {
		const { io, lines } = makeIO();
		await main(["nonsense"], io);
		expect(runOnboardCli).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(lines.join("\n")).toContain("npx @rine-network/mastra onboard");
	});
});
