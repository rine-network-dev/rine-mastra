/**
 * Mastra Funnel-wake proof: a one-shot defineAgent listener (the SAME SDK inbound
 * primitive Mastra's PollDriver/responder use) that wakes on a PRE-DELIVERED,
 * still-`new` rine.v1.webhook via the server's SSE catch-up, prints a marker, exits.
 * No Mastra Agent, no LLM — the load-bearing wake is the SDK dispatch.
 *
 * Lives inside the package `e2e/` dir so Node resolves `@rine-network/sdk` from
 * `rine-mastra/node_modules` (no ad-hoc NODE_PATH needed — see REQ-FSH-10).
 *
 *   RINE_CONFIG_DIR=/path/to/creds/leon RINE_E2E_MARKER=MASTRA-LIVE-xyz \
 *   RINE_E2E_HOOK=mast tsx rine-mastra/e2e/mastra_wake.ts
 */
import { AsyncRineClient, defineAgent, type DecryptedMessage } from "@rine-network/sdk";

const apiUrl = process.env.RINE_API_URL ?? "https://rine.network";
const configDir = process.env.RINE_CONFIG_DIR!; // /path/to/creds/leon
const hook = process.env.RINE_E2E_HOOK ?? ""; // metadata["rine.hook_name"] to match
const marker = process.env.RINE_E2E_MARKER ?? ""; // body marker to match (optional)
const timeoutMs = Number(process.env.RINE_E2E_WAKE_TIMEOUT ?? 90000);

const client = new AsyncRineClient({ configDir, apiUrl });
let done = false;

function bodyText(m: DecryptedMessage): string {
  const p = (m as unknown as { plaintext?: unknown }).plaintext;
  if (typeof p === "string") return p;
  if (p && typeof p === "object") return JSON.stringify(p);
  return String(p ?? "");
}

const agent = defineAgent({
  client,
  // onMessage form → no type filter → sees every non-reserved message, incl. webhook.
  onMessage: async (m: DecryptedMessage) => {
    if (done) return;
    if (m.type !== "rine.v1.webhook") return;
    const hookName = (m.metadata as Record<string, unknown> | undefined)?.["rine.hook_name"];
    const selfSend = m.from_agent_id === m.to_agent_id;
    const body = bodyText(m);
    const hookOk = !hook || hookName === hook;
    const markerOk = !marker || body.includes(marker);
    if (hookOk && markerOk) {
      done = true;
      // The exact, greppable success line:
      console.log(
        `MASTRA_FUNNEL_WAKE_OK id=${m.id} type=${m.type} hook=${String(hookName)} ` +
          `selfSend=${selfSend} enc=${m.encryption_version} verified=${(m as unknown as { verified?: unknown }).verified} ` +
          `decrypt_error=${(m as unknown as { decrypt_error?: unknown }).decrypt_error ?? "none"} body=${body.slice(0, 200)}`,
      );
      await agent.stop();
    }
  },
  onError: (err: unknown, ctx: { stage?: string }) =>
    console.error(`MASTRA_FUNNEL_WAKE_ERR stage=${ctx?.stage}: ${err}`),
});

setTimeout(async () => {
  if (!done) {
    console.error("MASTRA_FUNNEL_WAKE_TIMEOUT");
    await agent.stop();
    process.exitCode = 1;
  }
}, timeoutMs);
