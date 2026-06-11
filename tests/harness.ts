/**
 * Test harness — the load-bearing foundation every later stage reuses.
 *
 * Strategy (SPEC §17): mock ONLY the rine HTTP boundary; the rine SDK + ALL
 * crypto (real HPKE seal/open, signing, config resolution) run for REAL. We
 * intercept `globalThis.fetch` — the single funnel through which both the SDK's
 * `fetchWithAuth` and rine-core's crypto HTTP / OAuth all flow. A pre-seeded
 * `token_cache.json` means the OAuth mint never fires, so the only routes the
 * mock answers are real rine API paths.
 *
 * What it gives a test:
 *   - `makeHarness()` → a real on-disk config dir with REAL agent keys for a
 *     self-agent, a routable mock `fetch`, and a real `AsyncRineClient` wired to
 *     it (built via the package's own `getRineClient`, so the client-cache /
 *     config-resolution path under test is exercised).
 *   - `selfEncrypt(payload)` → a GENUINE HPKE envelope the self-agent can
 *     decrypt, so I-2 / plaintext assertions exercise real crypto, not a stub.
 *   - `route(method, pathRe, handler)` to register endpoint responses, and a
 *     `requests` log to assert the observable HTTP boundary (AC-1).
 *
 * Usage by later stages: register the routes a tool hits (e.g. `POST /messages`
 * for send, `GET /agents` + `GET /agents/{id}/messages` for check_inbox), drive
 * the tool's `execute(input, ctx)` with `ctx` from `makeCtx(h)`, and assert on
 * the returned string + `h.requests`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import {
	type AgentKeys,
	HttpClient,
	decryptMessage,
	encryptMessage,
	generateAgentKeys,
	saveAgentKeys,
	saveTokenCache,
	signingPublicKeyToJWK,
	toBase64Url,
} from "@rine-network/core";
import type { AsyncRineClient } from "@rine-network/sdk";
import { vi } from "vitest";
import { _resetClientCache, getRineClient } from "../src/client.js";
import {
	RINE_ACTING_AGENT,
	RINE_API_URL as RINE_API_URL_KEY,
	RINE_CONFIG_DIR,
	type RineToolContext,
} from "../src/context.js";

/** A sentinel ciphertext string seeded into envelopes for I-2 absence checks. */
export const SENTINEL_CIPHERTEXT = "SENTINEL_CIPHERTEXT_DO_NOT_LEAK_0xDEADBEEF";

export const SELF_AGENT_NAME = "support";
export const SELF_AGENT_ID = "11111111-1111-4111-8111-111111111111";
export const PEER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
export const PEER_HANDLE = "peer@acme.rine.network";
export const API_URL = "https://api.test.rine";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RecordedRequest {
	method: Method;
	path: string;
	url: string;
	body: unknown;
	headers: Record<string, string>;
}

type RouteHandler = (
	req: RecordedRequest,
) =>
	| { status?: number; json?: unknown }
	| Promise<{ status?: number; json?: unknown }>;

interface Route {
	method: Method;
	pathRe: RegExp;
	handler: RouteHandler;
}

export interface Harness {
	configDir: string;
	selfKeys: AgentKeys;
	peerKeys: AgentKeys;
	client: AsyncRineClient;
	requests: RecordedRequest[];
	/** Register a route. Routes are matched newest-first (override-friendly). */
	route(method: Method, pathRe: RegExp, handler: RouteHandler): void;
	/** Produce a real HPKE envelope payload the self-agent can decrypt. */
	selfEncrypt(payload: unknown): Promise<{
		encrypted_payload: string;
		encryption_version: string;
		sender_signing_kid: string | null;
	}>;
	/**
	 * Decrypt an OUTBOUND envelope (self → peer) as the peer would. Proves a
	 * lifecycle/send notify actually carried the expected plaintext over the wire
	 * (AC-13) — real HPKE open, not a stub. Returns the decrypted plaintext string.
	 */
	peerDecrypt(encryptedPayloadB64: string): Promise<string>;
	cleanup(): void;
}

/** The agent-list entry `GET /agents` returns (drives `resolveSenderId`). */
function agentRead(id: string, name: string, keys: AgentKeys) {
	return {
		id,
		name,
		handle: `${name}@acme.rine.network`,
		signing_public_key: signingPublicKeyToJWK(keys.signing.publicKey),
		encryption_public_key: {
			kty: "OKP",
			crv: "X25519",
			x: toBase64Url(keys.encryption.publicKey),
		},
	};
}

/** The `/agents/{id}/keys` response used during signature verification. */
function keysResponse(id: string, keys: AgentKeys) {
	return {
		agent_id: id,
		signing_public_key: signingPublicKeyToJWK(keys.signing.publicKey),
		encryption_public_key: {
			kty: "OKP",
			crv: "X25519",
			x: toBase64Url(keys.encryption.publicKey),
		},
	};
}

export function makeHarness(): Harness {
	const configDir = mkdtempSync(join(tmpdir(), "rine-mastra-"));
	const selfKeys = generateAgentKeys();
	const peerKeys = generateAgentKeys();
	saveAgentKeys(configDir, SELF_AGENT_ID, selfKeys);
	saveAgentKeys(configDir, PEER_AGENT_ID, peerKeys);

	// credentials.json so `loadCredentials` resolves the default profile, and a
	// non-expiring token_cache so the OAuth mint never hits the wire.
	writeFileSync(
		join(configDir, "credentials.json"),
		JSON.stringify({
			default: {
				client_id: "test-client",
				client_secret: "test-secret",
				poll_url: "/poll/test-token",
			},
		}),
	);
	saveTokenCache(configDir, {
		default: {
			access_token: "test-token",
			expires_at: Date.now() / 1000 + 3600,
		},
	});

	const requests: RecordedRequest[] = [];
	const routes: Route[] = [];

	// Default routes: the org agent list + per-agent key lookups, which the
	// sender-id resolver and signature verifier always need.
	routes.push({
		method: "GET",
		pathRe: /^\/agents$/,
		handler: () => ({
			json: {
				items: [
					agentRead(SELF_AGENT_ID, SELF_AGENT_NAME, selfKeys),
					agentRead(PEER_AGENT_ID, "peer", peerKeys),
				],
				total: 2,
				next_cursor: null,
				prev_cursor: null,
			},
		}),
	});
	routes.push({
		method: "GET",
		pathRe: new RegExp(`^/agents/${SELF_AGENT_ID}/keys$`),
		handler: () => ({ json: keysResponse(SELF_AGENT_ID, selfKeys) }),
	});
	routes.push({
		method: "GET",
		pathRe: new RegExp(`^/agents/${PEER_AGENT_ID}/keys$`),
		handler: () => ({ json: keysResponse(PEER_AGENT_ID, peerKeys) }),
	});

	const mockFetch = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			const u = new URL(url);
			const method = (init?.method ?? "GET").toUpperCase() as Method;
			const headers = normalizeHeaders(init?.headers);
			const body = parseBody(init?.body);
			const recorded: RecordedRequest = {
				method,
				path: u.pathname,
				url,
				body,
				headers,
			};
			requests.push(recorded);

			// Newest route wins so a test can override a default.
			for (let i = routes.length - 1; i >= 0; i--) {
				const r = routes[i];
				if (!r) continue;
				if (r.method === method && r.pathRe.test(u.pathname)) {
					const out = await r.handler(recorded);
					return jsonResponse(out.status ?? 200, out.json ?? {});
				}
			}
			return jsonResponse(404, {
				detail: `no mock route for ${method} ${u.pathname}`,
			});
		},
	);

	const realFetch = globalThis.fetch;
	globalThis.fetch = mockFetch as unknown as typeof fetch;

	_resetClientCache();
	const client = getRineClient({
		configDir,
		apiUrl: API_URL,
		agent: SELF_AGENT_NAME,
	});

	return {
		configDir,
		selfKeys,
		peerKeys,
		client,
		requests,
		route(method, pathRe, handler) {
			routes.push({ method, pathRe, handler });
		},
		async selfEncrypt(payload) {
			// REAL HPKE seal: peer signs, self decrypts. The resulting envelope is
			// genuinely openable by the self-agent in `read`/`check_inbox` tests.
			const enc = await encryptMessage(
				configDir,
				PEER_AGENT_ID,
				selfKeys.encryption.publicKey,
				payload,
			);
			return {
				encrypted_payload: enc.encrypted_payload,
				encryption_version: enc.encryption_version,
				sender_signing_kid: enc.sender_signing_kid ?? null,
			};
		},
		async peerDecrypt(encryptedPayloadB64) {
			// Open as the peer (the lifecycle recipient). The core HttpClient points
			// at the mock fetch's /agents/{id}/keys route for sender verification.
			const http = new HttpClient({
				apiUrl: API_URL,
				tokenFn: async () => "test-token",
				canRefresh: false,
			});
			const res = await decryptMessage(
				configDir,
				PEER_AGENT_ID,
				encryptedPayloadB64,
				http,
			);
			return res.plaintext;
		},
		cleanup() {
			globalThis.fetch = realFetch;
			_resetClientCache();
			rmSync(configDir, { recursive: true, force: true });
		},
	};
}

/**
 * Build a Mastra-tool `ctx` carrying the harness identity in a real
 * `RequestContext`, exactly as a host app would inject it. Later stages drive a
 * tool via `tool.execute(input, makeCtx(h))`.
 */
export function makeCtx(h: Harness): RineToolContext {
	const rc = new RequestContext();
	rc.set(RINE_ACTING_AGENT, SELF_AGENT_NAME);
	rc.set(RINE_CONFIG_DIR, h.configDir);
	rc.set(RINE_API_URL_KEY, API_URL);
	return { requestContext: rc };
}

/**
 * The minimal `createTool` shape a test drives: a string-returning `execute`.
 * The ctx param is `any` so the real Mastra `Tool` (whose `execute` declares the
 * full `ToolExecutionContext`) is assignable here — a rine tool reads only
 * `ctx.requestContext`, so the harness passes the narrower `RineToolContext`.
 */
interface ExecutableTool<I> {
	// biome-ignore lint/suspicious/noExplicitAny: accept any Mastra Tool's execute
	execute?: (inputData: I, ctx: any) => Promise<unknown>;
}

/**
 * Drive a rine tool's `execute(input, ctx)` with the harness identity and return
 * the rendered string. Centralizes the `execute?` optionality + the structural
 * ctx widening in ONE documented place — no per-call casts. Asserts a string
 * came back (every rine tool resolves a string).
 */
export async function runTool<I>(
	tool: ExecutableTool<I>,
	input: I,
	h: Harness,
): Promise<string> {
	if (!tool.execute) throw new Error("tool has no execute");
	const out = await tool.execute(input, makeCtx(h));
	return out as string;
}

function jsonResponse(status: number, json: unknown): Response {
	// 204/205/304 forbid a body — the Response constructor throws if one is given
	// (e.g. a `DELETE` returning 204 No Content).
	if (status === 204 || status === 205 || status === 304) {
		return new Response(null, { status });
	}
	return new Response(JSON.stringify(json), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function normalizeHeaders(
	h: RequestInit["headers"] | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!h) return out;
	if (h instanceof Headers) {
		h.forEach((v, k) => {
			out[k.toLowerCase()] = v;
		});
	} else if (Array.isArray(h)) {
		for (const pair of h) {
			const k = pair[0];
			const v = pair[1];
			if (k !== undefined) out[k.toLowerCase()] = String(v ?? "");
		}
	} else {
		for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
	}
	return out;
}

function parseBody(body: RequestInit["body"] | undefined): unknown {
	if (typeof body !== "string") return body ?? null;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}
