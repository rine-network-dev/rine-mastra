/**
 * AI-SDK interop smoke (the "AI-SDK interop" AC): a rine `createTool` tool sits
 * in a Mastra `Agent`'s `tools:{}` map ALONGSIDE a plain Vercel-`ai` `tool()`,
 * driven by a scripted `MockLanguageModelV3`. Asserts the model can call the rine
 * tool and its `execute` fires end-to-end (real SDK + crypto + mock boundary),
 * returning a real rendered string — proving the rine tools are valid AI-SDK
 * tools, not a bespoke shape. Mirrors the Phase-0 p03 probe.
 */

import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { tool as aiTool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { RINE_ACTING_AGENT, RINE_CONFIG_DIR } from "../src/context.js";
import { createRineInspectTool } from "../src/discovery.js";
import {
	API_URL,
	type Harness,
	SELF_AGENT_NAME,
	makeHarness,
} from "./harness.js";

let h: Harness;

beforeEach(() => {
	h = makeHarness();
});
afterEach(() => {
	h.cleanup();
});

const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("AI-SDK interop — a rine createTool beside a plain ai tool()", () => {
	it("the model calls the rine tool and its execute fires end-to-end", async () => {
		// A plain Vercel-ai tool() in the same map (proves coexistence).
		const plainTool = aiTool({
			description: "Echo back a value.",
			inputSchema: z.object({ value: z.string() }),
			execute: async ({ value }) => `echo:${value}`,
		});

		h.route("GET", new RegExp(`^/directory/agents/${A1}$`), () => ({
			json: {
				id: A1,
				name: "Alice",
				handle: "alice@acme",
				category: "research",
				verified: true,
				human_oversight: false,
			},
		}));

		const rineInspect = createRineInspectTool({
			configDir: h.configDir,
			apiUrl: API_URL,
		});

		// Mock model: step 1 calls rine_inspect; step 2 emits final text.
		let call = 0;
		const model = new MockLanguageModelV3({
			modelId: "mock-v3",
			doGenerate: async () => {
				call += 1;
				if (call === 1) {
					return {
						finishReason: "tool-calls",
						usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
						content: [
							{
								type: "tool-call",
								toolCallId: "tc-1",
								toolName: "rine_inspect",
								input: JSON.stringify({ handleOrId: A1 }),
							},
						],
						warnings: [],
						// biome-ignore lint/suspicious/noExplicitAny: mock model frame shape
					} as any;
				}
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					content: [{ type: "text", text: "Inspected the agent." }],
					warnings: [],
					// biome-ignore lint/suspicious/noExplicitAny: mock model frame shape
				} as any;
			},
		});

		const agent = new Agent({
			id: "rine-interop-agent",
			name: "Rine Interop Agent",
			instructions: "Use the tools to inspect rine agents.",
			// biome-ignore lint/suspicious/noExplicitAny: mock model is a structural V3
			model: model as any,
			// rine createTool BESIDE a plain ai tool() in one object map.
			tools: { rine_inspect: rineInspect, echo: plainTool },
		});

		const rc = new RequestContext();
		rc.set(RINE_ACTING_AGENT, SELF_AGENT_NAME);
		rc.set(RINE_CONFIG_DIR, h.configDir);

		const res = await agent.generate("Inspect the agent.", {
			requestContext: rc,
			maxSteps: 5,
		});

		// The model produced its final text…
		expect(res.text).toContain("Inspected the agent.");
		// …and the rine tool's execute genuinely ran against the mock boundary
		// (the directory GET was recorded), i.e. the tool is a real AI-SDK tool.
		const inspected = h.requests.find(
			(r) => r.method === "GET" && r.path === `/directory/agents/${A1}`,
		);
		expect(inspected).toBeDefined();
	});
});
