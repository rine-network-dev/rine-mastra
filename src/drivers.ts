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
 * I-1: NO `AsyncRineClient` and NO SSE loop are built at construction. The
 * `PollDriver` builds its client + `defineAgent` only on `start()`; the webhook
 * handler builds nothing until it is actually called.
 */

import {
	type DecryptedMessage,
	type RineAgent,
	defineAgent,
} from "@rine-network/sdk";
import { type RineClientOpts, getRineClient } from "./client.js";
import type { RineThreadResumer } from "./inbound.js";

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
	 * `defineAgent` actor (I-1 — nothing networked until now). Idempotent: a
	 * second call is a no-op while a loop is running.
	 */
	async start(): Promise<void> {
		if (this.agent) return;
		const client = getRineClient(this.clientOpts);
		this.agent = defineAgent({
			client,
			autoStart: false,
			onMessage: async (msg) => {
				await this.resumer.handleInbound(msg);
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
		if (agent) await agent.stop();
	}
}

/** A mounted webhook handler: feed it one inbound message, get the outcome. */
export type WebhookHandler = (
	msg: DecryptedMessage,
) => Promise<{ resumed: boolean }>;

/** Options for {@link makeWebhookHandler}. */
export interface WebhookHandlerOptions {
	/** The resumer each delivered message is dispatched to. */
	resumer: RineThreadResumer;
	/** Optional logger; defaults to `console`. */
	logger?: Pick<Console, "debug" | "warn" | "error">;
}

/**
 * The opt-in webhook wake driver. Returns a `Callable` the user invokes from
 * their own HTTP route on a rine outbound webhook delivery; it dispatches the
 * decrypted message to {@link RineThreadResumer.handleInbound} and reports
 * whether a run was resumed. I-1: builds nothing until called.
 *
 * The caller is responsible for decrypting the webhook payload into a
 * `DecryptedMessage` (e.g. via the SDK) before invoking the handler — keeping
 * crypto in the SDK and this handler transport-agnostic.
 */
export function makeWebhookHandler(
	opts: WebhookHandlerOptions,
): WebhookHandler {
	const log = opts.logger ?? console;
	return async (msg: DecryptedMessage) => {
		const outcome = await opts.resumer.handleInbound(msg);
		log.debug?.(
			`[rine] webhook ${msg.id} → ${outcome.resumed ? "resumed" : "skipped"}`,
		);
		return { resumed: outcome.resumed };
	};
}
