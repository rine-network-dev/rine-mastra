/**
 * I-1: side-effect-free import. Importing the package must NOT open a socket,
 * read a credential, or construct an `AsyncRineClient` at module load.
 *
 * Two angles:
 *   1. In-process: spy on `globalThis.fetch`, import the package fresh, assert
 *      zero fetch calls happened during evaluation.
 *   2. Subprocess: spawn a fresh `tsx` process whose preload shims `fetch` and
 *      `net.connect`/`net.Socket.connect` to THROW, then `import` the package.
 *      A clean exit proves nothing networked at import time.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const entry = resolve(pkgRoot, "src/index.ts");

afterEach(() => {
	vi.restoreAllMocks();
});

describe("I-1 — side-effect-free import (in-process)", () => {
	it("imports the package with zero fetch calls", async () => {
		vi.resetModules();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const mod = await import("../src/index.js");
		// The module evaluated; nothing networked, nothing built a client.
		expect(typeof mod.getRineClient).toBe("function");
		expect(fetchSpy).toHaveBeenCalledTimes(0);
	});
});

describe("I-1 — side-effect-free import (subprocess, network shimmed to throw)", () => {
	it("a fresh process imports the package without networking", () => {
		const script = `
			import net from "node:net";
			import fs from "node:fs";
			const boom = () => { throw new Error("I-1 VIOLATION: network at import"); };
			globalThis.fetch = boom;
			net.connect = boom;
			net.createConnection = boom;
			net.Socket.prototype.connect = boom;
			// I-1 forbids a credential read / config-dir mkdir at import too, not
			// just networking. Trip on any fs access that smells like config/creds.
			const fsBoom = (orig) => (p, ...rest) => {
				const s = String(p);
				if (/credentials\\.json|\\.rine|\\.config[\\\\/]+rine/.test(s)) {
					throw new Error("I-1 VIOLATION: credential/config fs access at import: " + s);
				}
				return orig(p, ...rest);
			};
			fs.readFileSync = fsBoom(fs.readFileSync);
			fs.existsSync = fsBoom(fs.existsSync);
			fs.mkdirSync = fsBoom(fs.mkdirSync);
			const mod = await import(${JSON.stringify(entry)});
			if (typeof mod.getRineClient !== "function") {
				console.error("export missing"); process.exit(2);
			}
			console.log("IMPORT_OK");
		`;
		const res = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script],
			{ cwd: pkgRoot, encoding: "utf-8", timeout: 60_000 },
		);
		expect(res.stderr).not.toContain("I-1 VIOLATION");
		expect(res.stdout).toContain("IMPORT_OK");
		expect(res.status).toBe(0);
	});
});
