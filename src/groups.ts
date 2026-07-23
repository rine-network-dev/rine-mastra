/**
 * The 6 group tools: `rine_group_create`, `rine_group_invite`,
 * `rine_group_remove`, `rine_group_inspect` (the INVERTED, MLS-capable
 * section), `rine_group_join`, `rine_group_invites`.
 *
 * `group_create` exposes `enableMls` (default true) — the headline differentiator:
 * the SDK best-effort-inits an MLS group and the renderer reports
 * `[OK] MLS`, not a `[WARN]` ceiling.
 *
 * The TS SDK's `groups.invite`/`removeMember`/`get` take BRANDED UUIDs
 * positionally (unlike the Python SDK, which resolved handles internally), so
 * invite/remove/inspect/join PRE-RESOLVE handle→UUID here:
 *   - a group → `groups.list()` + local match (`findGroup`),
 *   - an agent → `resolveToUuid` (WebFinger) → its UUID (or pass a UUID through).
 *     WebFinger — not the public directory — so unlisted agents resolve too.
 *
 * `rine_group_join`/`rine_group_invites` close the accept-side gap: an agent
 * invited into a group previously had no tool to join it or see its pending
 * invites (only create/invite/remove/inspect existed).
 */

import { createTool } from "@mastra/core/tools";
import { UUID_RE, normalizeHandle, resolveToUuid } from "@rine-network/core";
import { NotFoundError, asAgentUuid, asGroupUuid } from "@rine-network/sdk";
import type { AsyncRineClient } from "@rine-network/sdk";
import { strResult, type z } from "./_zod.js";
import { groupIsMls, renderGroup, renderInvites } from "./format.js";
import {
	groupCreateInput,
	groupInspectInput,
	groupInviteInput,
	groupInvitesInput,
	groupJoinInput,
	groupRemoveInput,
} from "./schemas.js";
import { type RineToolOpts, makeExecute } from "./tool.js";
import type { GroupRead } from "./types.js";

/** True for a bare UUID string (no `@`, matches the rine UUID shape). */
function isUuid(s: string): boolean {
	return UUID_RE.test(s);
}

/** A handle's bare local name: `#ops@acme` / `ops` → `ops`. */
function bareLocalName(handle: string): string {
	return handle.replace(/^#/, "").split("@")[0] ?? handle;
}

/**
 * Match a group among the caller's groups by UUID, full handle, or bare local
 * name. Ported from the Python `_find_group` (three branches): a UUID matches by
 * id; a bare name (no `@`) matches on the local part only (`ops` → `#ops@acme`);
 * a full handle (`#ops@acme`) matches the WHOLE normalized handle, org included —
 * so `#ops@acme` never matches `#ops@other-org`.
 */
function findGroup(
	groups: readonly GroupRead[],
	target: string,
): GroupRead | undefined {
	if (isUuid(target)) return groups.find((g) => g.id === target);
	if (!target.includes("@")) {
		const want = bareLocalName(target);
		return groups.find((g) => bareLocalName(g.handle) === want);
	}
	// A full handle matches the WHOLE normalized handle (org included). Group
	// handles are `#`-prefixed; prepend it when the caller omitted it, mirroring
	// the Python `_find_group`.
	const want = normalizeHandle(target.startsWith("#") ? target : `#${target}`);
	return groups.find((g) => normalizeHandle(g.handle) === want);
}

/** Resolve a group handle/UUID to its `GroupUuid` via the caller's group list. */
async function resolveGroupUuid(client: AsyncRineClient, target: string) {
	if (isUuid(target)) return asGroupUuid(target);
	const page = await client.groups.list();
	const match = findGroup(page.items, target);
	if (!match) {
		throw new NotFoundError(
			`No group '${target}' among the groups this agent belongs to`,
		);
	}
	return asGroupUuid(match.id);
}

/**
 * Resolve an agent handle/UUID to its `AgentUuid`. UUIDs pass through; a
 * `name@org` handle resolves via WebFinger (`resolveToUuid`) — NOT the public
 * directory — so it works for any live agent regardless of whether it publishes
 * a public agent card (the directory 404s for unlisted agents). This is the same
 * resolution the SDK's own 1:1 send path uses.
 */
async function resolveAgentUuid(apiUrl: string, target: string) {
	if (isUuid(target)) return asAgentUuid(target);
	return asAgentUuid(await resolveToUuid(apiUrl, target));
}

/**
 * Resolve a group handle/UUID to its `GroupUuid` for `rine_group_join`. Unlike
 * `resolveGroupUuid` (which searches `groups.list()` — groups the agent
 * ALREADY belongs to, so it can never see a group the agent has only been
 * invited to), this searches the caller's PENDING invites
 * (`groups.listInvites()`, enriched with `group_handle`/`group_name`) by UUID,
 * full handle, or bare local name.
 */
async function resolveJoinGroupUuid(client: AsyncRineClient, target: string) {
	if (isUuid(target)) return asGroupUuid(target);
	const invites = await client.groups.listInvites();
	const bare = !target.includes("@");
	const want = bare
		? bareLocalName(target)
		: normalizeHandle(target.startsWith("#") ? target : `#${target}`);
	const match = invites.find((r) => {
		if (r.group_handle) {
			return bare
				? bareLocalName(r.group_handle) === want
				: normalizeHandle(r.group_handle) === want;
		}
		return bare && r.group_name === target;
	});
	if (!match) {
		throw new NotFoundError(
			`No pending invite for group '${target}' — check rine_group_invites, or pass the group's UUID directly for an open-enrollment group`,
		);
	}
	return asGroupUuid(match.group_id);
}

/** `rine_group_create` — create an MLS-by-default coordination group. */
export function createRineGroupCreateTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_create",
		description:
			"Create a new end-to-end-encrypted coordination group. By default the group uses MLS (RFC 9420) encryption with forward secrecy. This is a real, irreversible network action. Returns the new group handle, id, E2EE mode, and enrollment policy.",
		inputSchema: groupCreateInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof groupCreateInput>>(
			opts,
			async (client, i) => {
				const g = await client.groups.create(i.name, {
					description: i.description,
					enrollment: i.enrollment,
					visibility: i.visibility,
					enableMls: i.enableMls,
				});
				// Read MLS via the capability check, NOT g.mls_group_id alone: the
				// server returns mls_group_id=null at create time and latches it only
				// on the separate MLS-init call, so a default MLS group would otherwise
				// mis-report as "sender-key" (g.mls_enabled is the source of truth here).
				const mode = groupIsMls(g) ? "MLS" : "sender-key";
				return `Created group ${g.handle} (id ${g.id}, ${mode} E2EE, enrollment ${g.enrollment_policy}).`;
			},
		),
	});
}

/** `rine_group_invite` — invite an agent into a group (handle→UUID pre-resolved). */
export function createRineGroupInviteTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_invite",
		description:
			"Invite an agent into a group your agent administers (group and agent may be handles or UUIDs). This is a real, irreversible network action. Returns the invite status.",
		inputSchema: groupInviteInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof groupInviteInput>>(
			opts,
			async (client, i, apiUrl) => {
				const groupId = await resolveGroupUuid(client, i.group);
				const agentId = await resolveAgentUuid(apiUrl, i.agentToInvite);
				const result = await client.groups.invite(groupId, agentId, {
					message: i.message,
				});
				return `Invited ${i.agentToInvite} to ${i.group} (status ${result.status}).`;
			},
		),
	});
}

/** `rine_group_remove` — remove a member; group keys rotate (handle→UUID pre-resolved). */
export function createRineGroupRemoveTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_remove",
		description:
			"Remove a member from a group your agent administers (group and agent may be handles or UUIDs). Group keys are rotated for forward secrecy. This is a real, irreversible network action.",
		inputSchema: groupRemoveInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof groupRemoveInput>>(
			opts,
			async (client, i, apiUrl) => {
				const groupId = await resolveGroupUuid(client, i.group);
				const agentId = await resolveAgentUuid(apiUrl, i.agentId);
				await client.groups.removeMember(groupId, agentId);
				return `Removed ${i.agentId} from ${i.group}; keys rotated.`;
			},
		),
	});
}

/** `rine_group_inspect` — report a group's E2EE mode + policy (`[OK] MLS` self-diagnosis). */
export function createRineGroupInspectTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_inspect",
		description:
			"Show a group's details and encryption status (MLS vs sender-key) so you can confirm your agent can read and post to it. Accepts a group handle or UUID.",
		inputSchema: groupInspectInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof groupInspectInput>>(
			opts,
			async (client, i) => {
				const page = await client.groups.list();
				const match = findGroup(page.items, i.group);
				if (!match) {
					throw new NotFoundError(
						`No group '${i.group}' among the groups this agent belongs to`,
					);
				}
				return renderGroup(match);
			},
		),
	});
}

/** `rine_group_join` — accept a pending invite / request to join (handle→UUID pre-resolved). */
export function createRineGroupJoinTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_join",
		description:
			"Join a group your agent was invited to (handle resolved against your pending invites — see rine_group_invites) or request to join an open group by UUID. Returns whether the join completed immediately or is pending approval. This is a real, irreversible network action.",
		inputSchema: groupJoinInput,
		outputSchema: strResult,
		mcp: { annotations: { destructiveHint: true } },
		execute: makeExecute<z.infer<typeof groupJoinInput>>(
			opts,
			async (client, i) => {
				const groupId = await resolveJoinGroupUuid(client, i.group);
				const result = await client.groups.join(groupId, {
					message: i.message,
				});
				if (result.status === "pending") {
					return `Join request for ${i.group} is pending approval (request ${result.request.id}).`;
				}
				return `Joined ${i.group} (member id ${result.member.id ?? result.member.agent_id}).`;
			},
		),
	});
}

/** `rine_group_invites` — list the caller's own pending group invites. */
export function createRineGroupInvitesTool(opts: RineToolOpts = {}) {
	return createTool({
		id: "rine_group_invites",
		description:
			"List the pending group invites and join requests for your agent, so you know which groups you can accept with rine_group_join.",
		inputSchema: groupInvitesInput,
		outputSchema: strResult,
		execute: makeExecute<z.infer<typeof groupInvitesInput>>(
			opts,
			async (client) => {
				const invites = await client.groups.listInvites();
				return renderInvites(invites);
			},
		),
	});
}
