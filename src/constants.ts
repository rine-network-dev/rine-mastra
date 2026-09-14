/**
 * The bounds on the set-aside retry.
 *
 * 🔴 **Every number here is a PARITY value.** The OpenClaw plugin
 * (`@rine-network/openclaw`) and the Hermes plugin (`hermes-rine`) carry the
 * same store under the same names, and all three run one policy against one
 * rine server — so a bound that differed here would be a difference nobody
 * chose. Change one and change all three, or say in the changelog why this
 * surface is deliberately not the others.
 */

/**
 * How many parked messages one store holds.
 *
 * 🔴 Overflow drops an ENTRY, never a message: the row is still in the rine
 * inbox (nothing on this path ever marked it delivered), so a dropped entry
 * loses only its automatic retry and `rine_inbox` / `rine_read` still reach the
 * message. The oldest exhausted entry goes first — it will never be retried, so
 * its only remaining value is being counted.
 *
 * Reachable only above 500 unreadable messages against one store, which is why
 * the cost of the higher number is a longer table and nothing else:
 * {@link SETASIDE_SWEEP_BATCH} — not this — is what bounds the work one sweep
 * spends.
 */
export const SETASIDE_MAX_ENTRIES = 500;

/**
 * Retries before a parked message stops being retried automatically.
 *
 * The bound is the whole reason a retry is safe to ship: a message that can
 * never be resumed must not re-read itself on every sweep forever. Exhaustion
 * does NOT acknowledge the row — the message stays in the rine inbox, and the
 * sweep says so once, in a warning, at the moment it gives up.
 */
export const SETASIDE_MAX_ATTEMPTS = 5;

/**
 * How many parked entries one sweep may retry.
 *
 * Each retry is a group sync at most once per group, a `GET /messages/{id}` and
 * a resume attempt, so an unbounded sweep over a full
 * {@link SETASIDE_MAX_ENTRIES} store is 500 of each on the tick of a timer.
 *
 * 🔴 Nothing is DROPPED by the bound — entries the batch does not reach keep
 * their place and their attempt counts — but nothing is promised the tail
 * either: the order is oldest-first on every sweep, not least-recently-tried,
 * so a store longer than one batch serves its head again and the tail waits for
 * that head to clear by healing or exhausting. Bounded by
 * {@link SETASIDE_MAX_ATTEMPTS} sweeps, and only reachable at all with more than
 * 50 parked messages.
 */
export const SETASIDE_SWEEP_BATCH = 50;

/**
 * Minimum wall-clock between two sweeps, and the interval timer's period.
 *
 * Two things ask for a sweep — the timer, which is what keeps a quiet channel
 * retrying, and the tail of each handled inbound message, because the thing that
 * heals a sealed group message is the sender-key distribution that has just gone
 * past. This bound is what stops the second from re-reading the store on every
 * frame of a busy stream, and what stops the two from running back to back.
 */
export const SETASIDE_SWEEP_INTERVAL_MS = 300_000;
