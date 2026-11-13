/** The public shapes of the Tier-3 resumer in `inbound.ts`. */

import type { ResumeSkipReason, SetAsideStore } from "./setaside.js";
import type { ThreadMapStore } from "./threadmap.js";
import type { ResumableWorkflow } from "./workflow.js";

/** Options for {@link RineThreadResumer}. */
export interface RineThreadResumerOptions {
	/** A pre-built workflow with snapshot storage already bound. */
	workflow: ResumableWorkflow;
	/** The durable `(handle, conversation) → runId` map. */
	threadMap: ThreadMapStore;
	/** The suspended step to resume; omit when exactly one step is suspended. */
	step?: unknown;
	/**
	 * Where a skipped message's id is recorded for the bounded retry. Defaults
	 * to an {@link InMemorySetAside}, which forgets everything on restart; pass a
	 * `SqliteSetAside` for a host whose parked messages must outlive it.
	 */
	setAside?: SetAsideStore;
	/** Optional logger; defaults to `console`. Used for skip-path diagnostics. */
	logger?: Pick<Console, "debug" | "warn">;
}

/** Outcome of {@link RineThreadResumer.handleInbound} — observable for drivers/tests. */
export type ResumeOutcome =
	| { resumed: true; runId: string }
	| { resumed: false; reason: ResumeSkipReason }
	| { resumed: false; reason: "control-frame" };
