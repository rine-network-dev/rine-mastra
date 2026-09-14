/**
 * Catch a parked message's GROUP up, before its decrypt is retried.
 *
 * The gap it closes: a group message sealed under a sender key this host does
 * not hold — or an MLS message whose commits it has not replayed — would be
 * re-read five times over twenty-five minutes while nothing ever asked the
 * server about the group. Every attempt after the first would be a rehearsal of
 * the first, and the bound would be spent on rehearsals. This surface holds a
 * sync TOOL of its own, but a message that resumes no run wakes no agent turn,
 * so an unattended host has nobody to call it.
 *
 * 🔴 It REUSES the SDK's `client.groups.sync`, which is `rine-core`'s
 * `recoverGroup` — the same function behind the `rine_group_sync` tool
 * (`groups-admin.ts`), reached the same way. Two consequences worth naming. The
 * automatic path and the asked-for one cannot drift into two recoveries. And the
 * invariants that function already holds are held here by construction rather
 * than by a comment:
 *
 *  - **Key-package replenishment fires on every MLS operation**, not only where
 *    a Welcome was processed. `recoverGroup` tops up AHEAD of its regime branch,
 *    so the top-up rides both the result and a resync refusal — which matters
 *    most here, because a host whose published key packages ran out is exactly
 *    the host whose state will not load.
 *  - **Welcomes are installed scoped or not at all.** `recoverGroup` installs
 *    none; the scoped install belongs to the read this runs in front of, which
 *    asks for one group's Welcomes by construction.
 *
 * 🔴 The group id came from the SERVER, on a row this package read a moment ago,
 * so it is untrusted input. It is guarded by `UUID_RE` before anything is
 * interpolated, so a `group_id` of `../agents/…` cannot become a URL — strictly,
 * and safely so, because the producer is the server's own UUID serialiser and
 * not a human typing a reference. No FILESYSTEM path is built from it here at
 * all: core keys MLS state by the hashed group id under a store root of its own,
 * so no spelling of it ever becomes a filename.
 */

import { UUID_RE } from "@rine-network/core";
import { type GroupUuid, asGroupUuid } from "@rine-network/sdk";
import { isGone } from "./setaside-words.js";

/** The one SDK call a pre-retry sync spends. Narrowed so a test can stand one up. */
export interface GroupSyncClient {
	groups: {
		/** `recoverGroup` behind the SDK's own resource; its report is not read here. */
		sync(group: GroupUuid): Promise<unknown>;
	};
}

/** The client and log one sync needs. `SweepArgs` extends this. */
export interface GroupSyncContext {
	client: GroupSyncClient;
	logger: Pick<Console, "debug" | "warn">;
}

/**
 * The groups one sweep has already asked about.
 *
 * Owned by `sweepSetAside` and threaded down, so the bound is one sync per group
 * per SWEEP and not one per entry: many entries parked on one group is the
 * ordinary shape of this store — one absent sender key seals every message sent
 * under it — and a recovery per entry would ask one question fifty times. A
 * `Set` and not a timestamp, because the sweep is already the clock.
 */
export type SyncedGroups = Set<string>;

/**
 * Ask the server to catch this group up, at most once per sweep, and never
 * throw.
 *
 * 🔴 Never throwing is the contract the sweep is written to. The re-read runs
 * whether this succeeded, failed or was skipped, so a failed sync cannot consume
 * an attempt that a decrypt never got — the bound counts retries of the read,
 * which is what it was sized for, and a server that is down for five minutes
 * does not exhaust a message's five chances without ever having tried one.
 *
 * Nor is a failure retried inside the sweep: the id joins {@link SyncedGroups}
 * BEFORE the await, so a group whose sync is failing costs one round trip per
 * sweep rather than one per parked entry.
 *
 * WARN and not DEBUG on failure: it is bounded to once per group per sweep, and
 * the two things it reports — a server that will not serve this group, and MLS
 * state that will not load at all — are both an operator's business. A group
 * that is GONE is the exception and reads as debug: the group was deleted, or
 * this host's org left it, and then there is nothing to catch up and nothing an
 * operator can do. A group still inside its own MLS init arrives here as the
 * SDK's refusal that there is no epoch chain to catch up with yet; that one
 * clears itself, and is bounded the same way.
 */
export async function syncGroupForRetry(
	a: GroupSyncContext,
	groupId: string,
	synced: SyncedGroups,
): Promise<void> {
	if (synced.has(groupId) || !UUID_RE.test(groupId)) return;
	synced.add(groupId);
	try {
		await a.client.groups.sync(asGroupUuid(groupId));
		a.logger.debug?.(
			`[rine] synced group ${groupId} before retrying its set-aside message(s)`,
		);
	} catch (err) {
		if (isGone(err)) {
			a.logger.debug?.(
				`[rine] group ${groupId} is gone — nothing to sync before its retry`,
			);
			return;
		}
		a.logger.warn?.(
			`[rine] could not sync group ${groupId} before retrying its set-aside message(s):`,
			err,
		);
	}
}
