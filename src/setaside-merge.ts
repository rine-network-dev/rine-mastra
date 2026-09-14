/**
 * The pure arithmetic one sighting, or one spent retry, does to one parked
 * entry — and the order a full store evicts in.
 *
 * ONE expression of each, shared by both {@link SetAsideStore} implementations:
 * the in-memory map and the libsql table both read what they hold, ask a
 * function here, and write back what it returned. The alternative is an
 * arithmetic upsert in SQL beside a merge in TypeScript, which is two definitions
 * of an attempt bound — and a bound that differs between the ephemeral store and
 * the durable one is a retry loop in production that no test reproduces.
 *
 * No I/O, no client, nothing here can fail. `now` is a parameter, not a
 * `Date.now()` call, so the arithmetic is testable without mocking the clock.
 */

import { SETASIDE_MAX_ATTEMPTS, SETASIDE_MAX_ENTRIES } from "./constants.js";
import { isPermanentSetAside } from "./setaside-words.js";
import type { SetAsideEntry, SetAsideSighting } from "./setaside-words.js";

/**
 * The entry a fresh sighting produces, given whatever the store already held.
 *
 * Idempotent on purpose. The live path parks a message the first time it cannot
 * resume it, and the sweep's retry runs through that same path — so a still-
 * unresumable message is re-recorded on every sweep. That re-record must NOT
 * count as an attempt; only {@link nextAttempt}, which the sweep calls once per
 * retry it actually ran, does. That is what keeps the bound a count of RETRIES
 * rather than a count of sightings.
 *
 * `firstSeen` survives, so the eviction order stays oldest-problem-first however
 * often a message is re-sighted. `exhausted` is sticky and a permanent reason
 * arrives already exhausted: a give-up is never undone by another sighting of
 * the same bytes.
 */
export function nextRecord(
	found: SetAsideEntry | undefined,
	sighting: SetAsideSighting,
	now: number,
): SetAsideEntry {
	return {
		...sighting,
		attempts: found?.attempts ?? 0,
		firstSeen: found?.firstSeen ?? now,
		lastTried: found?.lastTried ?? null,
		exhausted: isPermanentSetAside(sighting.reason) || (found?.exhausted ?? false),
	};
}

/**
 * The entry one spent retry produces.
 *
 * 🔴 `found` wins on the counters when the store still holds the entry, and the
 * caller's copy is the fallback — the sweep re-parks through the resumer, so the
 * row it counts against has just been rewritten by {@link nextRecord} and the
 * fresher count is the stored one. The attempt count only ever goes UP
 * (`Math.max`), because a re-record that arrived with no prior entry would
 * otherwise hand a permanently-failing message its whole budget again on every
 * sweep — an unbounded loop out of the one bound that exists to prevent it.
 */
export function nextAttempt(
	found: SetAsideEntry | undefined,
	entry: SetAsideEntry,
	now: number,
): SetAsideEntry {
	const attempts = Math.max(found?.attempts ?? 0, entry.attempts) + 1;
	return {
		...(found ?? entry),
		attempts,
		lastTried: now,
		exhausted:
			(found?.exhausted ?? entry.exhausted) || attempts >= SETASIDE_MAX_ATTEMPTS,
	};
}

/** Oldest entry first — the order every sweep serves and every store sorts by. */
export function byFirstSeen(a: SetAsideEntry, b: SetAsideEntry): number {
	return a.firstSeen - b.firstSeen;
}

/**
 * The ids to drop to bring a store back to {@link SETASIDE_MAX_ENTRIES}.
 *
 * Oldest exhausted first, then oldest overall. An exhausted entry is already
 * never retried, so all it loses is being counted; a live entry losing its place
 * loses a retry that could still have resumed the run. 🔴 Neither loses the
 * MESSAGE — nothing on this path ever acknowledged it, and its id was the only
 * thing being kept.
 */
export function overflowVictims(entries: readonly SetAsideEntry[]): string[] {
	const over = entries.length - SETASIDE_MAX_ENTRIES;
	if (over <= 0) return [];
	const byAge = [...entries].sort(byFirstSeen);
	const doomed = [
		...byAge.filter((e) => e.exhausted),
		...byAge.filter((e) => !e.exhausted),
	];
	return doomed.slice(0, over).map((e) => e.id);
}
