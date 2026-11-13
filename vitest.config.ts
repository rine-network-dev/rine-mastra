import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		maxWorkers: 4, // tank OOMs at one worker per CPU; `--maxWorkers=N` still overrides
		minWorkers: 1, // vitest <4 rejects maxWorkers below its default minimum
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
		// Tier-3 cross-process tests spawn fresh node processes and touch
		// libsql files; give them headroom over the 5s default.
		testTimeout: 30_000,
	},
});
