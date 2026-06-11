/**
 * `formatError(err)` — invariant I-3: turn any thrown SDK error into a readable
 * string for the LLM, never a stack trace. Tools wrap their one `await client.*`
 * call in `try/catch → formatError` and RESOLVE (never reject) for mapped errors.
 *
 * Ordering matters: the TS SDK error classes form a hierarchy rooted at
 * `RineApiError` (e.g. `AuthenticationError extends RineApiError`), so this maps
 * MOST-SPECIFIC FIRST and lets `RineApiError` be the catch-all for API errors.
 *
 * Differences from the Python `_format_error` (verified `rine-ts-sdk/src/errors.ts`):
 *   - there is NO `MlsUnsupportedError` — MLS works; a genuine future MLS-op
 *     failure surfaces as `CryptoError`/`RineApiError`, not a "can't do MLS"
 *     message.
 *   - there is NO `UnsupportedTargetError` — the group-on-`sendAndWait` case is
 *     a plain `Error` caught by message substring INSIDE the tool (see
 *     `isGroupUnsupportedOnWait`), not here.
 */

import {
	APIConnectionError,
	AuthenticationError,
	AuthorizationError,
	ConfigError,
	CryptoError,
	NotFoundError,
	RateLimitError,
	RineApiError,
	RineTimeoutError,
	SchemaValidationError,
	ValidationError,
} from "@rine-network/sdk";

/** The synchronous message thrown by `sendAndWait` for a `#` group handle. */
const GROUP_ON_WAIT_PREFIX = "sendAndWait() does not support group handles";

/**
 * True when `err` is the plain `Error` `sendAndWait` throws for a group handle.
 * The `send_and_wait` tool checks this BEFORE `formatError` and returns the
 * "1:1 only" guidance; it is not a typed SDK error class.
 */
export function isGroupUnsupportedOnWait(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith(GROUP_ON_WAIT_PREFIX);
}

/** The fixed reply for the group-on-`sendAndWait` case. */
export const GROUP_ON_WAIT_MESSAGE =
	"send_and_wait is 1:1 only; use rine_send for groups.";

export function formatError(err: unknown): string {
	if (err instanceof AuthenticationError) {
		return "Rine auth failed — set RINE_CLIENT_ID/RINE_CLIENT_SECRET or onboard (npx @rine-network/mastra onboard).";
	}
	if (err instanceof AuthorizationError) {
		return `Not authorized: ${err.detail}.`;
	}
	if (err instanceof NotFoundError) {
		return `Not found: ${err.detail}. Try rine_discover to find the right handle.`;
	}
	if (err instanceof RateLimitError) {
		const after = err.retryAfter ?? "a few";
		return `Rate-limited; retry after ${after}s.`;
	}
	// Both map to the same string, but read the right field: `ValidationError`
	// is a `RineApiError` (its `.message` carries a "422: …" status prefix, so
	// use `.detail`); `SchemaValidationError` is a `RineError` (use `.message`).
	if (err instanceof ValidationError) {
		return `Invalid input: ${err.detail}.`;
	}
	if (err instanceof SchemaValidationError) {
		return `Invalid input: ${err.message}.`;
	}
	if (err instanceof RineTimeoutError) {
		return "Request timed out; try again or raise the timeout.";
	}
	if (err instanceof ConfigError) {
		return String(err.message);
	}
	if (err instanceof CryptoError) {
		return `Encryption error: ${err.message} (check your agent keys are on disk).`;
	}
	if (err instanceof APIConnectionError) {
		return `Could not reach rine: ${err.message}.`;
	}
	// Catch-all for any other API error (5xx, 409, …). Must come AFTER the
	// specific subclasses above since they all extend `RineApiError`.
	if (err instanceof RineApiError) {
		return `${err.status}: ${err.detail}`;
	}
	return String(messageOf(err));
}

function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err ?? "unknown error");
}
