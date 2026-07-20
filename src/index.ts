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
 * Import is side-effect-free (I-1): nothing here constructs a client, reads a
 * credential, or opens a socket at module load.
 */

// Foundation — client + errors + formatting
export { getRineClient } from "./client.js";
export type { RineClientOpts } from "./client.js";
export { formatError } from "./errors.js";
export type { RinePaymentToolOpts, RineToolOpts } from "./tool.js";

// The 12 tool factories
export {
	createRineCheckInboxTool,
	createRineReadTool,
	createRineReplyTool,
	createRineSendAndWaitTool,
	createRineSendTool,
	createRineThreadTool,
} from "./messaging.js";
export {
	createRineDiscoverTool,
	createRineInspectTool,
} from "./discovery.js";
export {
	createRineGroupCreateTool,
	createRineGroupInspectTool,
	createRineGroupInviteTool,
	createRineGroupRemoveTool,
} from "./groups.js";
export {
	createRineFulfillTool,
	createRinePayTool,
} from "./payments.js";

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

// Tier-3 true idle-wake — workflow-resume bridge (the differentiator, SPEC §9)
export { RineThreadResumer } from "./inbound.js";
export type {
	ResumableRun,
	ResumableWorkflow,
	ResumeData,
	ResumeOutcome,
	RineThreadResumerOptions,
	WorkflowSnapshot,
} from "./inbound.js";
export {
	InMemoryThreadMap,
	SqliteThreadMap,
} from "./threadmap.js";
export type {
	SqliteThreadMapOptions,
	ThreadMapStore,
} from "./threadmap.js";
export { makeWebhookHandler, PollDriver } from "./drivers.js";
export type {
	PollDriverOptions,
	WebhookHandler,
	WebhookHandlerOptions,
} from "./drivers.js";

// Out-of-band onboard helper (the `npx @rine-network/mastra onboard` CLI; NEVER a tool)
export { parseOnboardArgs, runOnboard } from "./onboard.js";
export type { OnboardArgs, OnboardIO, OnboardOptions } from "./onboard.js";

// Identity-injection RequestContext keys (host apps set these on the ctx)
export {
	RINE_ACTING_AGENT,
	RINE_API_URL,
	RINE_CONFIG_DIR,
} from "./context.js";
export type { RineToolContext } from "./context.js";

// SDK-derived return types (re-derived from the SDK schemas)
export type {
	AgentProfile,
	AgentSummary,
	DecryptedMessage,
	GroupRead,
	InviteResult,
	MessageRead,
} from "./types.js";
