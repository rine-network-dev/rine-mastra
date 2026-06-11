/**
 * Error → string mapping (I-3 / SPEC §13). Each SDK error class maps to its
 * documented readable string; `formatError` always RESOLVES a string (it never
 * throws), so a tool's `execute` can return it directly without ever rejecting.
 * Ordering matters — the subclasses all extend `RineApiError`, so the table must
 * resolve most-specific-first.
 */

import {
	APIConnectionError,
	AuthenticationError,
	AuthorizationError,
	ConfigError,
	ConflictError,
	CryptoError,
	InternalServerError,
	NotFoundError,
	RateLimitError,
	RineApiError,
	RineTimeoutError,
	SchemaValidationError,
	ServiceUnavailableError,
	ValidationError,
} from "@rine-network/sdk";
import { describe, expect, it } from "vitest";
import {
	GROUP_ON_WAIT_MESSAGE,
	formatError,
	isGroupUnsupportedOnWait,
} from "../src/errors.js";

describe("formatError — §13 error table", () => {
	it("AuthenticationError → onboard guidance", () => {
		const out = formatError(new AuthenticationError("nope"));
		expect(out).toContain("Rine auth failed");
		expect(out).toContain("npx @rine-network/mastra onboard");
	});

	it("AuthorizationError → not authorized + detail", () => {
		expect(formatError(new AuthorizationError("you cannot"))).toBe(
			"Not authorized: you cannot.",
		);
	});

	it("NotFoundError → not found + discover hint", () => {
		const out = formatError(new NotFoundError("no agent xyz"));
		expect(out).toBe(
			"Not found: no agent xyz. Try rine_discover to find the right handle.",
		);
	});

	it("RateLimitError → retry-after seconds", () => {
		expect(formatError(new RateLimitError("slow down", 12))).toBe(
			"Rate-limited; retry after 12s.",
		);
	});

	it("RateLimitError without retryAfter → graceful fallback", () => {
		expect(formatError(new RateLimitError("slow down"))).toBe(
			"Rate-limited; retry after a fews.",
		);
	});

	it("ValidationError → invalid input", () => {
		expect(formatError(new ValidationError("bad field"))).toBe(
			"Invalid input: bad field.",
		);
	});

	it("SchemaValidationError → invalid input (both mapped)", () => {
		expect(formatError(new SchemaValidationError("schema mismatch"))).toBe(
			"Invalid input: schema mismatch.",
		);
	});

	it("RineTimeoutError → timed out", () => {
		expect(formatError(new RineTimeoutError("op timeout"))).toBe(
			"Request timed out; try again or raise the timeout.",
		);
	});

	it("ConfigError → raw message", () => {
		expect(formatError(new ConfigError("no poll url configured"))).toBe(
			"no poll url configured",
		);
	});

	it("CryptoError → encryption error + keys hint", () => {
		expect(formatError(new CryptoError("seal failed"))).toBe(
			"Encryption error: seal failed (check your agent keys are on disk).",
		);
	});

	it("APIConnectionError → could not reach", () => {
		expect(formatError(new APIConnectionError("ECONNREFUSED"))).toBe(
			"Could not reach rine: ECONNREFUSED.",
		);
	});

	it("ConflictError (no specific branch) → catch-all status:detail", () => {
		expect(formatError(new ConflictError("dup name"))).toBe("409: dup name");
	});

	it("InternalServerError → catch-all status:detail", () => {
		expect(formatError(new InternalServerError("boom"))).toBe("500: boom");
	});

	it("ServiceUnavailableError → catch-all status:detail", () => {
		expect(formatError(new ServiceUnavailableError("maint"))).toBe(
			"503: maint",
		);
	});

	it("bare RineApiError → status:detail", () => {
		expect(formatError(new RineApiError(418, "teapot"))).toBe("418: teapot");
	});

	it("plain Error → message fallthrough", () => {
		expect(formatError(new Error("unexpected"))).toBe("unexpected");
	});

	it("non-Error value → stringified", () => {
		expect(formatError("just a string")).toBe("just a string");
		expect(formatError(null)).toBe("unknown error");
	});

	it("never throws for any mapped error (always resolves a string)", () => {
		const cases: unknown[] = [
			new AuthenticationError(),
			new NotFoundError(),
			new RateLimitError("x"),
			new ValidationError(),
			new CryptoError("x"),
			new ConfigError("x"),
			new RineApiError(500, "x"),
			new Error("x"),
			undefined,
			42,
		];
		for (const c of cases) {
			expect(typeof formatError(c)).toBe("string");
		}
	});
});

describe("isGroupUnsupportedOnWait — substring catch (not a typed error)", () => {
	it("matches the sendAndWait group-handle Error message", () => {
		const err = new Error(
			"sendAndWait() does not support group handles — the server's /messages/sync endpoint is 1:1 only.",
		);
		expect(isGroupUnsupportedOnWait(err)).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isGroupUnsupportedOnWait(new Error("something else"))).toBe(false);
		expect(isGroupUnsupportedOnWait(new NotFoundError("x"))).toBe(false);
		expect(isGroupUnsupportedOnWait("not an error")).toBe(false);
	});

	it("carries the fixed 1:1-only guidance string", () => {
		expect(GROUP_ON_WAIT_MESSAGE).toBe(
			"send_and_wait is 1:1 only; use rine_send for groups.",
		);
	});
});
