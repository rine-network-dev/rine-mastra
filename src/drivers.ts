/**
 * Tier-3 wake drivers. Two ways to feed inbound rine messages
 * into a {@link RineThreadResumer}:
 *
 *   - {@link PollDriver} (default) — a long-lived host loop over the SDK's
 *     `defineAgent`/`watch` SSE delivery. Each inbound message →
 *     `resumer.handleInbound(msg)`. Works anywhere with outbound connectivity,
 *     zero infra.
 *   - {@link makeWebhookHandler} (opt-in) — returns a `Callable` the user mounts
 *     on their own HTTP route (rine outbound webhook → resume). Needs ingress.
 *
 * **Serverless caveat (docs must shout):** Mastra's built-in scheduler and a
 * poll loop **silently never fire** on Vercel/Netlify/Lambda/CF Workers (the
 * process dies between requests) — `@mastra/inngest` is required there.
 *
 * Both drivers run the resumer's bounded retry (`setaside-schedule.ts`) at the
 * TAIL of each message they hand over, and the `PollDriver` additionally runs it
 * on a timer — which is the half a push transport cannot supply itself. Never in
 * front of a message: a retry of an old one must not delay the live one.
 *
 * NO `AsyncRineClient` and NO SSE loop are built at construction. The
 * `PollDriver` builds its client + `defineAgent` only on `start()`; the webhook
 * handler builds nothing until its first call.
 */

import {
	type DecryptedMessage,
	type RineAgent,
	defineAgent,
} from "@rine-network/sdk";
import { type RineClientOpts, getRineClient } from "./client.js";
import type { RineThreadResumer } from "./inbound.js";
import { startSweepSchedule } from "./setaside-schedule.js";

/** Options for {@link PollDriver}. Client overrides thread through to the SDK. */
export interface PollDriverOptions extends RineClientOpts {
	/** The resumer every inbound SSE message is dispatched to. */
	resumer: RineThreadResumer;
	/** Optional logger; defaults to `console`. */
	logger?: Pick<Console, "debug" | "warn" | "error">;
}

/**
 * The default Tier-3 wake driver: a long-lived `defineAgent` SSE loop that wakes
 * suspended workflow runs. Build it, then call {@link start}; call {@link stop}
 * on teardown. The SDK isolates per-message handler errors, so one bad message
 * never tears down the loop.
 */
export class PollDriver {
	private readonly resumer: RineThreadResumer;
	private readonly clientOpts: RineClientOpts;
	private readonly log: Pick<Console, "debug" | "warn" | "error">;
	private agent?: RineAgent;
	/**
	 * Bounds the retry timer to this driver's own lifetime, so a stopped driver
	 * holds no interval and a restarted one gets a fresh schedule.
	 */
	private lifetime?: AbortController;

	constructor(opts: PollDriverOptions) {
		this.resumer = opts.resumer;
		this.clientOpts = {
			configDir: opts.configDir,
			apiUrl: opts.apiUrl,
			agent: opts.agent,
		};
		this.log = opts.logger ?? console;
	}

	/**
	 * Start the SSE delivery loop. Lazily builds the `AsyncRineClient` + the
	 * `defineAgent` actor — nothing is networked until now. Idempotent: a
	 * second call is a no-op while a loop is running.
	 */
	async start(): Promise<void> {
		if (this.agent) return;
		const client = getRineClient(this.clientOpts);
		this.lifetime = new AbortController();
		// 🔴 The server marks a streamed frame delivered as it yields it, so a
		// message this loop skips is already consumed. The resumer records its id
		// and this is what retries it: on the interval, and at the tail of each
		// message, which is when a sender key that seals a parked group message is
		// most likely to have just arrived.
		const sweep = startSweepSchedule({
			client,
			resumer: this.resumer,
			logger: this.log,
			signal: this.lifetime.signal,
		});
		this.agent = defineAgent({
			client,
			autoStart: false,
			onMessage: async (msg) => {
				await this.resumer.handleInbound(msg);
				// AFTER the live message, never in front of it, and gated so a busy
				// stream sweeps on the interval rather than on every frame.
				await sweep();
			},
			onError: (err, ctx) => {
				this.log.warn?.(`[rine] PollDriver ${ctx.stage} error:`, err);
			},
		});
		await this.agent.start();
	}

	/** Stop the SSE loop, draining in-flight handlers. Idempotent. */
	async stop(): Promise<void> {
		const agent = this.agent;
		this.agent = undefined;
		this.lifetime?.abort();
		this.lifetime = undefined;
		if (agent) await agent.stop();
	}
}

/** A mounted webhook handler: feed it one inbound message, get the outcome. */
export type WebhookHandler = (
	msg: DecryptedMessage,
) => Promise<{ resumed: boolean }>;

/**
 * Options for {@link makeWebhookHandler}. Client overrides thread through to the
 * SDK, and are spent only by the bounded retry — the handler itself is handed an
 * already-decrypted message and asks the server nothing.
 */
export interface WebhookHandlerOptions extends RineClientOpts {
	/** The resumer each delivered message is dispatched to. */
	resumer: RineThreadResumer;
	/** Optional logger; defaults to `console`. */
	logger?: Pick<Console, "debug" | "warn" | "error">;
}

/**
 * The opt-in webhook wake driver. Returns a `Callable` the user invokes from
 * their own HTTP route on a rine outbound webhook delivery; it dispatches the
 * decrypted message to {@link RineThreadResumer.handleInbound} and reports
 * whether a run was resumed. It builds nothing — no client, no loop — until
 * it is actually called.
 *
 * The caller is responsible for decrypting the webhook payload into a
 * `DecryptedMessage` (e.g. via the SDK) before invoking the handler — keeping
 * crypto in the SDK and this handler transport-agnostic.
 *
 * 🔴 The bounded retry runs at the TAIL of each delivery, and there is no timer:
 * this driver has no lifetime to hang one on. On a long-lived host (an Express
 * route) the cadence gate holds and the retry runs at most every five minutes;
 * on a process that dies between requests the gate dies with it, so the retry
 * runs once per delivery — which is also the only retry such a platform can run
 * at all, and it is bounded by the sweep batch and by there being anything
 * parked.
 */
export function makeWebhookHandler(
	opts: WebhookHandlerOptions,
): WebhookHandler {
	const log = opts.logger ?? console;
	// Built on the first delivery, not here, so mounting a route still opens no
	// socket and reads no credential — and kept, so the cadence gate inside the
	// schedule survives between deliveries on a host that lives that long.
	let sweep: (() => Promise<void>) | undefined;
	return async (msg: DecryptedMessage) => {
		const outcome = await opts.resumer.handleInbound(msg);
		log.debug?.(
			`[rine] webhook ${msg.id} → ${outcome.resumed ? "resumed" : "skipped"}`,
		);
		// Guarded, and guarded HERE rather than inside the schedule, because building
		// the client is the one step of the retry that is outside the sweep's own
		// catch: an unreadable config dir must not reject an HTTP route whose
		// message has already been resumed.
		try {
			sweep ??= startSweepSchedule({
				client: getRineClient({
					configDir: opts.configDir,
					apiUrl: opts.apiUrl,
					agent: opts.agent,
				}),
				resumer: opts.resumer,
				logger: log,
			});
			await sweep();
		} catch (err) {
			log.warn?.("[rine] set-aside retry could not run:", err);
		}
		return { resumed: outcome.resumed };
	};
}
