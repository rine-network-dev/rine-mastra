#!/usr/bin/env node
// prepublishOnly guard: refuse to publish if any dependency still resolves to a local
// `file:` path. The publish flow (scripts/publish-package.sh --external) rewrites
// `file:` deps to semver before `npm publish`; this is the fail-fast backstop so a
// tarball with literal `file:../rine-ts-sdk` paths (uninstallable) can never escape.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const offenders = [];
for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
	for (const [name, value] of Object.entries(pkg[section] ?? {})) {
		if (typeof value === "string" && value.startsWith("file:")) {
			offenders.push(`${section}.${name} = ${value}`);
		}
	}
}

if (offenders.length > 0) {
	console.error(
		`refusing to publish @rine-network/mastra: unresolved file: deps —\n  ${offenders.join(
			"\n  ",
		)}\nPublish via scripts/publish-package.sh --external rine-mastra (it rewrites file: → semver).`,
	);
	process.exit(1);
}
