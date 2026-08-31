/**
 * `rineToolkit(opts)` — the aggregator. Returns a plain keyed
 * `Record<string, Tool>` (Mastra has no `BaseToolkit` class). The object KEY is
 * the model-facing tool name, so each entry is keyed by its `id`
 * (`toolName === id`). Drop the record straight into a Mastra `Agent`'s
 * `tools: {}` map.
 *
 * `include` curates the surface: `"all"` (25), one domain
 * (`"messaging"`/`"discovery"`/`"groups"`/`"payments"`), or an array union of
 * domains. The `"payments"` domain (`rine_pay`, `rine_fulfill`) moves funds —
 * bounded by the on-disk spend policy (deny-by-default) and by auto-pay, OFF
 * unless the toolkit turns it on.
 *
 * Shared client: ONE lazily-built `AsyncRineClient` is created per
 * `rineToolkit(...)` call and threaded into every tool's `opts.client`, so all
 * tools share a client (and the warm OAuth token cache). Per-acting-agent
 * variants derive cheaply via `client.withAgent(...)` inside each `execute`.
 *
 * The individual `createRine<X>Tool(opts)` factories are also re-exported for the
 * "attach only what you need" ergonomic.
 */

import type { Tool } from "@mastra/core/tools";
import { getRineClient } from "./client.js";
import {
	createRineDiscoverTool,
	createRineInspectTool,
	createRineWhoamiTool,
} from "./discovery.js";
import {
	createRineGroupLeaveTool,
	createRineGroupReclaimTool,
	createRineGroupRequestsTool,
	createRineGroupSyncTool,
	createRineGroupVoteTool,
} from "./groups-admin.js";
import {
	createRineDiscoverGroupsTool,
	createRineGroupRosterTool,
	createRineGroupsTool,
} from "./groups-list.js";
import {
	createRineGroupCreateTool,
	createRineGroupInspectTool,
	createRineGroupInviteTool,
	createRineGroupInvitesTool,
	createRineGroupJoinTool,
	createRineGroupRemoveTool,
} from "./groups.js";
import {
	createRineInboxTool,
	createRineReadTool,
	createRineReplyTool,
	createRineSendAndWaitTool,
	createRineSendTool,
	createRineThreadTool,
} from "./messaging.js";
import { createRineFulfillTool, createRinePayTool } from "./payments.js";
import type { RinePaymentToolOpts } from "./tool.js";

/** The domains a toolkit can be filtered to. */
export type RineToolDomain = "messaging" | "discovery" | "groups" | "payments";

/** The tool factories grouped by domain (drives the `include` filter). */
const DOMAINS: Record<
	RineToolDomain,
	readonly ((opts: RinePaymentToolOpts) => Tool)[]
> = {
	messaging: [
		createRineSendTool,
		createRineSendAndWaitTool,
		createRineInboxTool,
		createRineReadTool,
		createRineReplyTool,
		createRineThreadTool,
	],
	discovery: [
		createRineDiscoverTool,
		createRineInspectTool,
		createRineDiscoverGroupsTool,
		createRineWhoamiTool,
	],
	groups: [
		createRineGroupsTool,
		createRineGroupCreateTool,
		createRineGroupInviteTool,
		createRineGroupRemoveTool,
		createRineGroupInspectTool,
		createRineGroupRosterTool,
		createRineGroupJoinTool,
		createRineGroupInvitesTool,
		createRineGroupRequestsTool,
		createRineGroupVoteTool,
		createRineGroupLeaveTool,
		createRineGroupSyncTool,
		createRineGroupReclaimTool,
	],
	payments: [createRinePayTool, createRineFulfillTool],
};

const ALL_DOMAINS: readonly RineToolDomain[] = [
	"messaging",
	"discovery",
	"groups",
	"payments",
];

/**
 * Payment configuration for the `"payments"` domain tools (`rine_pay`,
 * `rine_fulfill`). All optional; the tools work with sensible defaults (auto-pay
 * OFF, marker ON) and a facilitator is only needed to `rine_fulfill`.
 */
export interface RinePaymentsConfig {
	/** Auto-pay default (default OFF). See {@link RinePaymentToolOpts.autoPay}. */
	autoPay?: RinePaymentToolOpts["autoPay"];
	/** Facilitator for `rine_fulfill`. See {@link RinePaymentToolOpts.facilitator}. */
	facilitator?: RinePaymentToolOpts["facilitator"];
	/** Default for the cleartext marker (default ON). */
	emitMarker?: RinePaymentToolOpts["emitMarker"];
}

/** Options for {@link rineToolkit}. */
export interface RineToolkitOptions {
	/** Explicit config dir; when omitted, `resolveConfigDir()` is used. */
	configDir?: string;
	/** Explicit API URL; when omitted, `resolveApiUrl()` is used. */
	apiUrl?: string;
	/** Acting agent (handle/name/UUID) sent on every request. */
	agent?: string;
	/** Which tools to include. Default `"all"`. */
	include?: "all" | RineToolDomain | readonly RineToolDomain[];
	/** Config for the `"payments"` domain tools (auto-pay OFF by default). */
	payments?: RinePaymentsConfig;
}

/** Resolve the `include` option to the ordered set of domains to build. */
function resolveDomains(
	include: RineToolkitOptions["include"],
): readonly RineToolDomain[] {
	if (include === undefined || include === "all") return ALL_DOMAINS;
	if (typeof include === "string") return [include];
	// Array union, de-duplicated while preserving the canonical domain order.
	return ALL_DOMAINS.filter((d) => include.includes(d));
}

/**
 * Build the rine tool record. The returned object is keyed by each tool's `id`
 * (so `toolName === id`), ready to spread into a Mastra `Agent`'s `tools` map.
 */
export function rineToolkit(
	opts: RineToolkitOptions = {},
): Record<string, Tool> {
	// ONE shared lazy client per toolkit call. `getRineClient` does NOT
	// connect at construction — the socket-less client is built here so
	// every tool reuses it and the token cache stays warm.
	const sharedClient = getRineClient({
		configDir: opts.configDir,
		apiUrl: opts.apiUrl,
		agent: opts.agent,
	});
	const toolOpts: RinePaymentToolOpts = {
		configDir: opts.configDir,
		apiUrl: opts.apiUrl,
		agent: opts.agent,
		client: sharedClient,
		autoPay: opts.payments?.autoPay,
		facilitator: opts.payments?.facilitator,
		emitMarker: opts.payments?.emitMarker,
	};

	const out: Record<string, Tool> = {};
	for (const domain of resolveDomains(opts.include)) {
		for (const factory of DOMAINS[domain]) {
			const tool = factory(toolOpts);
			out[tool.id] = tool;
		}
	}
	return out;
}
