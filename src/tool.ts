/**
 * Shared `createTool` plumbing every rine tool reuses (no duplicated logic):
 * identity injection (I-1 lazy client + I-2 no-creds-in-schema) and the
 * try/catch → `formatError` wrapper (I-3 errors→strings, never a reject).
 *
 * A tool's per-tool body is just `(client, inputData) => string`; this helper
 * supplies the surrounding contract:
 *   1. read the acting agent + config-dir/api-url overrides from
 *      `ctx.requestContext` (NEVER `inputSchema`), falling back to the
 *      `rineToolkit(opts)` overrides closed over at factory time,
 *   2. lazily build/get the shared `AsyncRineClient` (I-1 — first call only),
 *   3. run the body, and on any thrown SDK error return `formatError(err)` so
 *      the tool RESOLVES a readable string and never rejects (I-3).
 *
 * `createTool` from `@mastra/core/tools` is invoked by each domain module; this
 * file only builds the `execute` closure and the shared option/ctx types.
 */

import { resolveApiUrl } from "@rine-network/core";
import type {
	AgentHandle,
	AgentUuid,
	AsyncRineClient,
	GroupHandle,
	GroupUuid,
} from "@rine-network/sdk";
import { type RineClientOpts, getRineClient } from "./client.js";
import {
	RINE_ACTING_AGENT,
	RINE_API_URL,
	RINE_CONFIG_DIR,
	type RineToolContext,
	readContext,
} from "./context.js";
import { formatError } from "./errors.js";

/**
 * Per-factory overrides threaded from `rineToolkit(opts)` / an individual
 * `createRine<X>Tool(opts)` call. A live `client` may be passed so every tool in
 * one `rineToolkit(...)` call shares ONE lazily-built client (AC-11); when
 * omitted, each tool resolves its own client lazily on first `execute`.
 */
export interface RineToolOpts extends RineClientOpts {
	/** A shared client to reuse (set by `rineToolkit` for AC-11). */
	client?: AsyncRineClient;
}

/**
 * Resolve the effective `AsyncRineClient` for one `execute` call: prefer a
 * shared client from the toolkit, else build one from the ctx-injected identity
 * layered over the factory defaults. Lazy by construction — only runs inside
 * `execute` (I-1).
 */
export function resolveClient(
	opts: RineToolOpts,
	ctx: RineToolContext | undefined,
): AsyncRineClient {
	if (opts.client) {
		const agent = readContext(ctx, RINE_ACTING_AGENT) ?? opts.agent;
		return agent ? opts.client.withAgent(agent) : opts.client;
	}
	return getRineClient({
		configDir: readContext(ctx, RINE_CONFIG_DIR) ?? opts.configDir,
		apiUrl: readContext(ctx, RINE_API_URL) ?? opts.apiUrl,
		agent: readContext(ctx, RINE_ACTING_AGENT) ?? opts.agent,
	});
}

/**
 * The same resolved `apiUrl` `resolveClient` builds its client against (ctx
 * override → factory override → `resolveApiUrl()`). Exposed so handle→UUID
 * pre-resolution (`resolveToUuid`) hits the SAME server WebFinger the client
 * uses, since the SDK client has no public `apiUrl` getter.
 */
export function resolveApiUrlFor(
	opts: RineToolOpts,
	ctx: RineToolContext | undefined,
): string {
	return readContext(ctx, RINE_API_URL) ?? opts.apiUrl ?? resolveApiUrl();
}

/**
 * The recipient union `client.send`/`sendAndWait` accept. The model supplies a
 * free-form `to` string (a `name@org` handle, a `#group@org` handle, or a UUID);
 * the SDK normalizes + validates it at runtime, so this brands the string once,
 * in one documented place, rather than scattering casts.
 */
type Recipient = AgentHandle | AgentUuid | GroupHandle | GroupUuid;

/** Brand a model-supplied recipient string for the SDK send surface. */
export function asRecipient(to: string): Recipient {
	return to as Recipient;
}

/**
 * I-2 layer (c): the belt-and-suspenders ciphertext redactor for `read` /
 * `check_inbox` (SPEC §2.2 / D-output). Layers (a) plaintext-only renderers and
 * (b) `outputSchema: z.string()` already guarantee the `execute` return is a
 * redacted string; this coerces ANY value to plain text content before it can
 * reach the model, so even a regression that returned a richer object containing
 * ciphertext could not surface it. Returns Mastra's default text-content shape.
 */
export function redactToText(output: unknown): { type: "text"; value: string } {
	return { type: "text", value: typeof output === "string" ? output : "" };
}

/**
 * A tool body: one client call rendered to a string. The wrapper handles errors.
 * `apiUrl` is the server the client is bound to (for handle→UUID pre-resolution);
 * bodies that don't resolve handles ignore it.
 */
export type RineToolBody<I> = (
	client: AsyncRineClient,
	inputData: I,
	apiUrl: string,
) => Promise<string>;

/**
 * Build a Mastra-tool `execute(inputData, ctx)` from a body, applying the
 * lazy-client + try/catch→formatError contract. Use as the `execute` value of a
 * `createTool({...})` config.
 */
export function makeExecute<I>(opts: RineToolOpts, body: RineToolBody<I>) {
	return async (inputData: I, ctx: RineToolContext): Promise<string> => {
		try {
			const client = resolveClient(opts, ctx);
			return await body(client, inputData, resolveApiUrlFor(opts, ctx));
		} catch (err) {
			return formatError(err);
		}
	};
}
