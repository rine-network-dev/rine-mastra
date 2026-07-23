/**
 * Outbound lifecycle bridge `rineLifecycle`.
 *
 * Mastra has NO callback-handler object class. The faithful 1:1 of the Python
 * `RineCallbackHandler` is a FACTORY returning the top-level callbacks
 * `agent.stream(...)` / `agent.generate(...)` accept — verified identical across
 * both methods. Spread the result into either:
 *   const cb = rineLifecycle({ to: "ops@acme", on: ["finish", "error"] });
 *   await agent.stream(input, { ...cb });    // or .generate(input, { ...cb })
 *
 * Selector → callback map (port verbatim from the Python listener):
 *   finish → onFinish     ({text,…})              → "agent finished: {text}"
 *   error  → onError      ({error})               → "agent error: {error}"
 *   step   → onStepFinish ({toolCalls,…})         → "step: {toolName}"
 *
 * Invariants:
 *   - I-1: opt-in by instantiation; the `AsyncRineClient` is built lazily on the
 *     FIRST fired callback (never at module load or in this factory body).
 *   - I-2: only the model-visible `text` / tool name / error message is summarized
 *     into the notify body — never ciphertext (these callbacks never see an
 *     envelope).
 *   - Best-effort: each fired callback attempts EXACTLY ONE `client.send` (AC-13);
 *     a send failure is swallowed + debug-logged and never thrown out of the
 *     callback (AC-14) — a notify failure must not crash the agent run.
 */

import { type RineClientOpts, getRineClient } from "./client.js";
import { asRecipient } from "./tool.js";

/** Max characters of a summary line sent as a notify body (port verbatim). */
const _MAX_SUMMARY = 500;

/** The lifecycle selectors a caller can opt into. */
export type RineLifecycleEvent = "finish" | "error" | "step";

/** Options for {@link rineLifecycle}. */
export interface RineLifecycleOptions extends RineClientOpts {
	/** Recipient handle/UUID every notify is sent to (`name@org`, `#group@org`). */
	to: string;
	/** Which lifecycle events fire a notify. Defaults to `["finish", "error"]`. */
	on?: readonly RineLifecycleEvent[];
}

/** The callback bag spread into `agent.stream(...)` / `agent.generate(...)`. */
export interface RineLifecycleCallbacks {
	onFinish?: (event: unknown) => void;
	onError?: (event: unknown) => void;
	onStepFinish?: (event: unknown) => void;
}

/** Truncate a one-line summary to the notify ceiling. */
function summarize(text: string): string {
	return text.length > _MAX_SUMMARY ? `${text.slice(0, _MAX_SUMMARY)}…` : text;
}

/** The model-visible final text off an `onFinish` / `onStepFinish` event. */
function eventText(event: unknown): string {
	const text = (event as { text?: unknown } | undefined)?.text;
	return typeof text === "string" ? text : "";
}

/** The first tool name off an `onStepFinish` event's `toolCalls`, if any. */
function firstToolName(event: unknown): string | undefined {
	const calls = (event as { toolCalls?: unknown } | undefined)?.toolCalls;
	if (!Array.isArray(calls) || calls.length === 0) return undefined;
	const first = calls[0] as { toolName?: unknown } | undefined;
	return typeof first?.toolName === "string" ? first.toolName : undefined;
}

/** The error message off an `onError` event (`{ error: Error | string }`). */
function eventError(event: unknown): string {
	const err = (event as { error?: unknown } | undefined)?.error;
	if (err instanceof Error) return err.message;
	return typeof err === "string" ? err : String(err ?? "unknown error");
}

/**
 * Build the opt-in outbound lifecycle bridge. Returns ONLY the callbacks for the
 * selected events (so `{ ...cb }` never installs a no-op for an unselected one).
 * The client is resolved lazily on the first fired callback (I-1).
 */
export function rineLifecycle(
	opts: RineLifecycleOptions,
): RineLifecycleCallbacks {
	const on = opts.on ?? ["finish", "error"];
	const clientOpts: RineClientOpts = {
		configDir: opts.configDir,
		apiUrl: opts.apiUrl,
		agent: opts.agent,
	};

	/** Fire exactly one best-effort notify; swallow + debug-log any failure. */
	async function notify(body: string): Promise<void> {
		try {
			const client = getRineClient(clientOpts);
			await client.send(
				asRecipient(opts.to),
				{ text: summarize(body) },
				{ type: "rine.v1.text" },
			);
		} catch (err) {
			// AC-14: never propagate out of the callback — a failed notify must not
			// crash the agent run. Debug-log only.
			console.debug?.("[rine] lifecycle notify failed:", err);
		}
	}

	const cb: RineLifecycleCallbacks = {};
	if (on.includes("finish")) {
		cb.onFinish = (event) => {
			void notify(`agent finished: ${eventText(event)}`);
		};
	}
	if (on.includes("error")) {
		cb.onError = (event) => {
			void notify(`agent error: ${eventError(event)}`);
		};
	}
	if (on.includes("step")) {
		cb.onStepFinish = (event) => {
			const tool = firstToolName(event);
			void notify(`step: ${tool ?? eventText(event)}`);
		};
	}
	return cb;
}
