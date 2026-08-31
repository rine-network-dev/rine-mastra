/**
 * Identity injection via Mastra's `RequestContext` (BLOCKING — verified
 * in-rig). The acting agent + config dir are read from `ctx.requestContext`
 * inside a tool's `execute`, NEVER from the model-visible `inputSchema` — the
 * host injects the identity, the model never chooses it (also Mastra's own
 * security rule). Keys are `rine-`-namespaced to avoid collision
 * with Mastra's reserved `mastra__*` keys.
 *
 * Import the `RequestContext` class itself from `@mastra/core/request-context`
 * (the `./runtime-context` subpath does NOT exist on @mastra/core 1.41.0; there
 * is NO `runtimeContext` field on the execute ctx).
 */

/** RequestContext key carrying the acting agent (handle/name/UUID). */
export const RINE_ACTING_AGENT = "rine-acting-agent";

/** RequestContext key carrying the explicit config dir override. */
export const RINE_CONFIG_DIR = "rine-config-dir";

/** RequestContext key carrying the explicit API-URL override. */
export const RINE_API_URL = "rine-api-url";

/**
 * The slice of a Mastra tool-`execute` ctx the rine tools read. Structurally
 * typed (a `.get(key)` reader) so the package does not hard-depend on a Mastra
 * type that ships under a class we'd have to import at runtime — and so tests
 * can pass a plain object. The real `ctx.requestContext` satisfies this.
 */
export interface RineToolContext {
	requestContext?: {
		get(key: string): unknown;
	};
}

/** Read a string value from a tool ctx's requestContext, or undefined. */
export function readContext(
	ctx: RineToolContext | undefined,
	key: string,
): string | undefined {
	const v = ctx?.requestContext?.get(key);
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
