/**
 * AGENT handle → UUID resolution for the group tools, and the two group
 * resolutions that are the SDK's rather than this package's.
 *
 * 🔴 **Group references are not resolved here any more.** This module
 * used to answer them from `groups.list()` and a local three-branch match, a
 * fourth copy of a ladder the SDK now owns: `client.groups.resolveRef` reads a
 * UUID from the group's own indexed row, a handle from the server's own lookup,
 * and a bare name from the org's list — and answers with the group's whole
 * record, so a verb handed the record reads no group of its own. Every group
 * tool in this package calls that seam directly; nothing re-derives a row at a
 * call site, and nothing here restates the ladder.
 *
 * What is left is the resolution the SDK does NOT do for these tools:
 *   - an agent → `resolveToUuid` (WebFinger) → its UUID (or pass a UUID
 *     through). WebFinger — not the public directory — so unlisted agents
 *     resolve too. This is the same resolution the SDK's own 1:1 send path uses.
 *   - a group for `rine_group_join`, which is a DIFFERENT ladder and is
 *     documented as such on {@link resolveJoinGroupUuid}.
 *
 * Split out of `groups.ts` so that file holds its six tool definitions and
 * nothing else; the aggregator (`tools.ts`) never imports this module, so the
 * shipped-surface gate's `id: "rine_*"` scan is unaffected by the move.
 */

import { UUID_RE, handleCompletionNotes, resolveToUuid } from "@rine-network/core";
import { asAgentUuid } from "@rine-network/sdk";
import type { AsyncRineClient } from "@rine-network/sdk";

/** True for a bare UUID string (no `@`, matches the rine UUID shape). */
function isUuid(s: string): boolean {
	return UUID_RE.test(s);
}

/**
 * A tool's answer, led by the item-18 completion notice when there is one.
 *
 * 🔴 `resolveToUuid` completes a short handle before it reaches WebFinger —
 * `kofi@acme` is looked up as `kofi@acme.rine.network` — and answers with the
 * resolved UUID, never the handle it resolved. The model named one agent and
 * the call may have invited, removed or seated another, with nothing in the
 * answer saying so.
 *
 * 🔴 A LINE, not a key, and that is this surface's shape rather than a choice:
 * every tool here declares `strResult`, so there is no object to hang a field
 * on. `@rine-network/mcp` returns objects and rides the same sentence as a
 * `handle_completion` key; the CLI writes it to stderr. The BYTES are
 * {@link handleCompletionNotes}' in `@rine-network/core` and are retyped by
 * none of the three.
 *
 * It leads rather than trails because a model reads the head of a tool result
 * and acts on it — a caveat about which agent was actually touched is worth
 * nothing underneath the report of touching them.
 */
export function withHandleCompletionLine(
	answer: string,
	spellings: readonly string[],
): string {
	const note = handleCompletionNotes(spellings);
	return note === undefined ? answer : `${note}\n${answer}`;
}

/** Resolve an agent handle/UUID to its `AgentUuid` (UUIDs pass through). */
export async function resolveAgentUuid(apiUrl: string, target: string) {
	if (isUuid(target)) return asAgentUuid(target);
	return asAgentUuid(await resolveToUuid(apiUrl, target));
}

/**
 * Resolve a batch of agent handles/UUIDs, **in the order they were named**.
 *
 * Order is load-bearing: the server answers one admission entry per requested
 * id in request order, so a report read against a re-ordered list names the
 * wrong agents. Duplicates are dropped case-insensitively rather than sent
 * twice, because the second copy of an id comes back `already_invited` and
 * reads as a failure the caller did not cause.
 */
export async function resolveAgentUuids(apiUrl: string, targets: string[]) {
	const resolved = [];
	const seen = new Set<string>();
	for (const target of targets) {
		const id = await resolveAgentUuid(apiUrl, target);
		const key = id.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		resolved.push(id);
	}
	return resolved;
}

/**
 * Resolve a group handle/UUID to its `GroupUuid` for `rine_group_join`.
 *
 * 🔴 The SDK's own join ladder, not a copy of one, and NOT the ladder the other
 * twelve group tools take. `client.groups.resolveRef` is scoped at every rung
 * to a group the caller's scope already owns or is seated in — which for a join is the one
 * set the target cannot be in — and this package
 * used to answer instead from `groups.listInvites()` alone, so the commonest
 * join there is, a handle read straight off `rine_discover_groups`, was refused
 * here with the server never having been asked. `resolveRefForJoin` walks the
 * this agent's seats, then its invitations, then the org's open and voted groups, then the
 * public directory, matching the handle exactly at every rung. What this package could always do
 * it still does: a BARE name resolves against this agent's own pending
 * invitations — and against nothing else, because that list is the only set
 * bounded to groups that have already asked for this agent, and a join cannot
 * be taken back (`rine-core/src/resolve-group-join.ts` `resolveGroupUuidForJoin`).
 *
 * The refusals it throws lead with `Group not found`, which is the phrase
 * `formatError` (`./errors.ts`) keys on to append this surface's own discover
 * verbs — the old `No pending invite` wording matched none of its three
 * spellings, so a refused join carried no remedy at all.
 */
export async function resolveJoinGroupUuid(
	client: AsyncRineClient,
	target: string,
) {
	return await client.groups.resolveRefForJoin(target);
}
