/**
 * WHEN the bounded retry runs. What it does when it runs is
 * `setaside-sweep.ts`; what it reads and writes is `setaside.ts`.
 *
 * Two triggers, one gate:
 *
 *  - a TIMER, so a quiet channel still retries. A driver over a push transport
 *    has no tick of its own, so without this a host that received nothing for
 *    six hours would retry nothing for six hours — and the entries most likely
 *    to heal are exactly the ones a since-restarted peer has since sent a key
 *    for.
 *  - the TAIL of each handled inbound message, because the thing that heals a
 *    sealed group message is the sender-key distribution that has just gone
 *    past. Sweeping then is the moment the store is most likely to open, and it
 *    costs no wall-clock the live message was waiting on: it runs after the
 *    resume, never in front of it.
 *
 * 🔴 One gate for both, so they can never run back to back or on top of each
 * other: `lastSweep` bounds the cadence and `sweeping` bounds the overlap. A
 * busy stream therefore sweeps on the interval and not on every frame, and the
 * timer finds the work already done.
 *
 * 🔴 What is NOT serialised, stated rather than discovered: a sweep can resume a
 * healed message's run while a live message's resume is in flight. Two different
 * runs are independent; two resumes of the SAME run cannot happen this way,
 * because a run that is no longer suspended is skipped by the `not-suspended`
 * arm.
 */

import { SETASIDE_SWEEP_INTERVAL_MS } from "./constants.js";
import { sweepSetAside } from "./setaside-sweep.js";
import type { SweepArgs } from "./setaside-sweep.js";

/** Everything the sweep needs, plus the lifetime that bounds the timer. */
export interface ScheduleArgs extends SweepArgs {
	/**
	 * The driver's own signal. The timer is cleared when it aborts, which is what
	 * keeps a stopped driver from holding the event loop or reading a config dir
	 * the host has moved on from.
	 *
	 * Optional, because the webhook driver has no lifetime to hang a timer on: a
	 * serverless process dies between requests, so a timer there is at best
	 * pointless and at worst a handle nothing closes. Omit it and the schedule is
	 * the tail trigger alone — which is the only one that can fire there anyway.
	 */
	signal?: AbortSignal;
}

/**
 * Start the interval (when a signal bounds one) and hand back the gated sweep.
 *
 * Returns a function rather than an object: there is one thing to ask for, it
 * never throws, and a caller that awaits it is awaiting the same single-flight
 * sweep the timer would have run.
 */
export function startSweepSchedule(a: ScheduleArgs): () => Promise<void> {
	// Zero, not Date.now(): the first inbound message after a restart should retry
	// whatever the previous process set aside, rather than wait out an interval it
	// never served.
	let lastSweep = 0;
	let sweeping = false;

	async function sweep(): Promise<void> {
		if (sweeping || Date.now() - lastSweep < SETASIDE_SWEEP_INTERVAL_MS) return;
		lastSweep = Date.now();
		sweeping = true;
		try {
			await sweepSetAside(a);
		} catch (err) {
			// Belt to the sweep's own braces: a retry must never cost the live
			// message that triggered it, and must never take down the timer.
			a.logger.warn?.("[rine] set-aside sweep failed:", err);
		} finally {
			sweeping = false;
		}
	}

	const signal = a.signal;
	if (signal && !signal.aborted) {
		const timer = setInterval(() => void sweep(), SETASIDE_SWEEP_INTERVAL_MS);
		// Unref'd so the retry schedule can never be the reason a Node process
		// declines to exit; the abort listener is what actually stops it.
		timer.unref?.();
		signal.addEventListener("abort", () => clearInterval(timer), { once: true });
	}
	return sweep;
}
