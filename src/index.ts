/**
 * @rine-network/mastra — native Mastra.ai tools for the rine network.
 *
 * E2E-encrypted (HPKE 1:1, MLS groups RFC 9420, PQ-hybrid) agent-to-agent
 * messaging, discovery, and coordination as Mastra `createTool` tools, plus a
 * toolkit aggregator, a lifecycle bridge, a Tier-3 workflow-resume bridge, and
 * an out-of-band onboard CLI.
 *
 * Re-export surface — filled out as the build stages land the tools, the
 * aggregator, the lifecycle bridge, and the Tier-3 apparatus. The foundation
 * (client builder, error formatter, renderers, schemas) is exported now so
 * tests and downstream stages can consume it.
 *
 * Import is side-effect-free: nothing here constructs a client, reads a
 * credential, or opens a socket at module load.
 */

// Foundation — client + errors + formatting
export { getRineClient } from "./client.js";
export type { RineClientOpts } from "./client.js";
export { formatError } from "./errors.js";
export type { RinePaymentToolOpts, RineToolOpts } from "./tool.js";

// The 25 tool factories
export {
	createRineInboxTool,
	createRineReadTool,
	createRineReplyTool,
	createRineSendAndWaitTool,
	createRineSendTool,
	createRineThreadTool,
} from "./messaging.js";
export {
	createRineDiscoverTool,
	createRineInspectTool,
	createRineWhoamiTool,
} from "./discovery.js";
export {
	createRineDiscoverGroupsTool,
	createRineGroupRosterTool,
	createRineGroupsTool,
} from "./groups-list.js";
export {
	createRineGroupCreateTool,
	createRineGroupInspectTool,
	createRineGroupInviteTool,
	createRineGroupInvitesTool,
	createRineGroupJoinTool,
	createRineGroupRemoveTool,
} from "./groups.js";
export {
	createRineGroupLeaveTool,
	createRineGroupReclaimTool,
	createRineGroupRequestsTool,
	createRineGroupSyncTool,
	createRineGroupVoteTool,
} from "./groups-admin.js";
export { createRineFulfillTool, createRinePayTool } from "./payments.js";

// The toolkit aggregator
export { rineToolkit } from "./tools.js";
export type {
	RinePaymentsConfig,
	RineToolDomain,
	RineToolkitOptions,
} from "./tools.js";

// Outbound lifecycle bridge (opt-in; spread into agent.stream/.generate)
export { rineLifecycle } from "./lifecycle.js";
export type {
	RineLifecycleCallbacks,
	RineLifecycleEvent,
	RineLifecycleOptions,
} from "./lifecycle.js";

// Tier-3 true idle-wake — workflow-resume bridge (the differentiator)
export { RineThreadResumer } from "./inbound.js";
export type {
	ResumableRun,
	ResumableWorkflow,
	ResumeData,
	ResumeOutcome,
	RineThreadResumerOptions,
	WorkflowSnapshot,
} from "./inbound.js";
export { InMemoryThreadMap, SqliteThreadMap } from "./threadmap.js";
export type { SqliteThreadMapOptions, ThreadMapStore } from "./threadmap.js";
export { makeWebhookHandler, PollDriver } from "./drivers.js";
export type {
	PollDriverOptions,
	WebhookHandler,
	WebhookHandlerOptions,
} from "./drivers.js";

// The set-aside store behind the resumer's bounded retry. A driver wires its own
// sweep, so a host reaches for these only to make a parked message survive a
// restart (`SqliteSetAside`) or to read the bounds it is running under.
export {
	SETASIDE_MAX_ATTEMPTS,
	SETASIDE_MAX_ENTRIES,
	SETASIDE_SWEEP_BATCH,
	SETASIDE_SWEEP_INTERVAL_MS,
} from "./constants.js";
export { InMemorySetAside } from "./setaside.js";
export type {
	ResumeSkipReason,
	SetAsideEntry,
	SetAsideReason,
	SetAsideSighting,
	SetAsideStore,
} from "./setaside.js";
export { SqliteSetAside } from "./setaside-sqlite.js";
export type { SqliteSetAsideOptions } from "./setaside-sqlite.js";
// Both drivers here already wire this. It is exported for the host that feeds
// `handleInbound` from a loop of its own, which would otherwise record parked
// messages and never retry them.
export { startSweepSchedule } from "./setaside-schedule.js";
export type { ScheduleArgs } from "./setaside-schedule.js";

// Out-of-band onboard helper (the `npx @rine-network/mastra onboard` CLI; NEVER a tool)
export { parseOnboardArgs, runOnboard } from "./onboard.js";
export type { OnboardArgs, OnboardIO, OnboardOptions } from "./onboard.js";

// Identity-injection RequestContext keys (host apps set these on the ctx)
export { RINE_ACTING_AGENT, RINE_API_URL, RINE_CONFIG_DIR } from "./context.js";
export type { RineToolContext } from "./context.js";

// SDK-derived return types (re-derived from the SDK schemas)
export type {
	AgentProfile,
	AgentSummary,
	DecryptedMessage,
	GroupRead,
	InviteResult,
	JoinRequestRead,
	MessageRead,
} from "./types.js";
