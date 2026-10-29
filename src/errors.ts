/**
 * `formatError(err)` — turns any thrown SDK error into a readable
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
	GROUP_ROSTER_LEAD,
	NO_GROUPS_IN_ORG,
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
 * The `rine_send_and_wait` tool checks this BEFORE `formatError` and returns
 * the "1:1 only" guidance; it is not a typed SDK error class.
 */
export function isGroupUnsupportedOnWait(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith(GROUP_ON_WAIT_PREFIX);
}

/**
 * The fixed reply for the group-on-`sendAndWait` case.
 *
 * 🔴 It names `rine_send_and_wait`, the id this surface actually registers
 * (`./messaging.ts`). A model reads a refusal literally and calls the verb the
 * sentence names, so a bare `send_and_wait` here spends the turn on a
 * tool-not-found.
 */
export const GROUP_ON_WAIT_MESSAGE =
	"rine_send_and_wait is 1:1 only; use rine_send for groups.";

/**
 * A group 404 has THREE producers on this stack, two spellings, and only one of
 * them is a `NotFoundError`.
 *
 *   - the **server** answers a bare `Group not found` (404 → `NotFoundError`);
 *   - the **TS SDK** resolves the handle itself before every group send and
 *     throws a PLAIN `Error`, `Group not found: <handle>` (`resolveGroup`;
 *     `rine-core`'s `getOrCreateSenderKey` throws the same shape);
 *   - the SDK's group **resolver** (`groups.resolveRef`) refuses the same way
 *     for every group verb on this surface that names a group, and its refusal
 *     is a plain `Error` carrying the same lead plus the caller's own roster.
 *
 * 🔴 `err instanceof NotFoundError` is therefore not the test. Keyed on the
 * class, the commonest group failure there is — a mistyped handle on
 * `rine_send` — fell past the branch to the bare `String(err.message)` arm with
 * no remedy at all: exactly the misdirection this predicate exists to remove.
 * The predicate reads the MESSAGE, whichever class carried it.
 *
 * 🔴 **A third producer used to be this package itself** — `groups.list()` plus
 * a local match, refusing with a sentence of its own — and it went when that
 * local ladder did. Everything a group verb here refuses with is now the SDK's
 * own sentence, which is what lets {@link groupNotFoundMessage} key on the
 * SDK's constants rather than on a local literal.
 *
 * A group needs the group half of the directory: `rine_discover` searches
 * AGENTS and can never resolve a group handle, so pointing a missing group at
 * it sends the caller to a search that structurally cannot answer.
 */
const GROUP_NOT_FOUND_LEAD = "Group not found";

/**
 * The SECOND lead, and the one a BARE recipient name now carries.
 *
 * The bare-name miss stopped leading with a group verdict — both namespaces
 * have answered no by then, and the sentence says so — but the REMEDY below is
 * unchanged, and that is the whole reason this constant exists here. Dropping
 * the first lead without adding this one routes every bare-name miss to
 * `formatError`'s catch-all, which names `rine_discover`: the public AGENT
 * directory, which cannot resolve a group handle. That is exactly the
 * misdirection this constant exists to prevent, restored silently, with every
 * suite green.
 *
 * Pinned against `rine-core`, `rine-sdk` and the four other reading surfaces by
 * `NEITHER_NAMESPACE_LEAD_COPIES` (`tests/helpers_client_paths.py`).
 */
const NEITHER_NAMESPACE_LEAD = "names neither an agent nor a group you can reach";

/**
 * True for a group 404 in any of its spellings, whatever class carried it.
 *
 * 🔴 The second lead is matched by CONTAINMENT, not prefix: its sentence opens
 * with the caller's own spelling (`'kofi' names neither …`), so `startsWith`
 * cannot see it and the arm would read as "not a group problem" forever.
 *
 * 🔴 An AMBIGUOUS bare name is deliberately NOT one: `Group name 'ops' is
 * ambiguous — more than one group answers to it.` already names the groups it
 * is torn between, so it reaches `formatError`'s catch-all and prints verbatim
 * with no verb appended. Widening this predicate to catch it would
 * append a "go and list your groups" remedy underneath a refusal that is
 * already showing the list.
 */
function isGroupNotFound(text: string): boolean {
	return text.startsWith(GROUP_NOT_FOUND_LEAD) || text.includes(NEITHER_NAMESPACE_LEAD);
}

/**
 * The one remedy all three take.
 *
 * `rine_groups` is named FIRST because it resolves a group the caller's org
 * holds a seat in, public or private. `rine_discover_groups` searches the
 * directory, which the server filters to `visibility == "public"`, so it
 * structurally cannot answer for a private group — it is named second because
 * it is the right tool for finding a public group you have never joined.
 */
const GROUP_NOT_FOUND_REMEDY =
	"Try rine_groups to find the right group handle, or rine_discover_groups to search the public directory.";

/** The half of that remedy that is still worth naming once the roster is in hand. */
const SEARCH_THE_DIRECTORY =
	"Try rine_discover_groups to search the public directory.";

/**
 * A group refusal, plus the tool that can answer it — and one verb fewer when
 * the refusal has already answered itself.
 *
 * The SDK resolves a group reference against the caller's own groups and, on a
 * miss, hands back the list it was holding: {@link GROUP_ROSTER_LEAD} opens the
 * roster, {@link NO_GROUPS_IN_ORG} is the arm for an org that holds a seat
 * nowhere. Printing "run `rine_groups`" underneath either one tells a model to
 * go and fetch what it is already reading — the `rine_discover` defect
 * inverted, and measured to be worse than a wasted call: models parrot the hint
 * back as their answer instead of acting on it. `rine_discover_groups` is then
 * the only verb that can still find something new, so it is the only one named.
 * A **server** group 404 carries no roster and keeps both verbs.
 *
 * The roster arm ends on a LIST ROW, not on a sentence, so the clause joins
 * with a newline and the lead's own full stop is dropped: `(Planning).` reads
 * as part of that last group's entry, and a caller copying the row it was told
 * to name copies the period into the retry.
 *
 * Both sentences are imported from the SDK rather than retyped, so a reword
 * there cannot leave a stale literal here quietly restoring the loop.
 */
function groupNotFoundMessage(detail: string): string {
	if (detail.includes(GROUP_ROSTER_LEAD)) {
		return `Not found: ${detail}\n${SEARCH_THE_DIRECTORY}`;
	}
	if (detail.includes(NO_GROUPS_IN_ORG)) {
		return `Not found: ${detail} ${SEARCH_THE_DIRECTORY}`;
	}
	// 🔴 The detail's own trailing stop is dropped, never doubled. Every join
	// refusal now ends on `JOIN_TAKES_A_HANDLE_OR_AN_ID`, a full sentence, so a
	// lead that appends its own `.` unconditionally prints "… or its id.. Try
	// rine_groups …". The three Python connectors have always rstripped here
	// (`detail.rstrip(".")`), and a punctuation difference between the two
	// stacks is the same twin break as a reworded sentence.
	return `Not found: ${detail.replace(/\.+$/, "")}. ${GROUP_NOT_FOUND_REMEDY}`;
}

export function formatError(err: unknown): string {
	if (err instanceof AuthenticationError) {
		return "Rine auth failed — RINE_CONFIG_DIR must point at an onboarded agent runtime dir (npx @rine-network/mastra onboard).";
	}
	if (err instanceof AuthorizationError) {
		return `Not authorized: ${err.detail}.`;
	}
	if (err instanceof NotFoundError) {
		if (isGroupNotFound(err.detail)) {
			return groupNotFoundMessage(err.detail);
		}
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
	// A plain `Error`, and the arm the SDK's own handle resolution lands in — so
	// this, not the `NotFoundError` branch above, is what a mistyped group handle
	// on `rine_send` reaches. Everything else stringifies as before.
	const message = String(messageOf(err));
	if (isGroupNotFound(message)) {
		return groupNotFoundMessage(message);
	}
	return message;
}

function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err ?? "unknown error");
}
