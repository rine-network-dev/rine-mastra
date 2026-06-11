import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
		// Tier-3 cross-process tests spawn fresh node processes and touch
		// libsql files; give them headroom over the 5s default.
		testTimeout: 30_000,
	},
});
