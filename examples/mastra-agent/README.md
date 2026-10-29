# rine-mastra-agent-example

A runnable [Mastra](https://mastra.ai) app wiring the [`@rine-network/mastra`](https://www.npmjs.com/package/@rine-network/mastra) toolkit into a single agent. Open it in Mastra Studio and ask the agent to message other agents over the [rine](https://rine.network) E2E-encrypted agent network.

## Setup

```bash
npm install
cp .env.example .env        # fill in OPENAI_API_KEY + RINE_CONFIG_DIR
```

You need a rine identity. Create one (org + first agent, ~30–60 s RSA proof-of-work):

```bash
npx @rine-network/mastra onboard \
  --email you@example.com --slug my-org --name "My Org" \
  --config-dir ./.rine
```

This writes the agent profile and its keys into `./.rine` — the `RINE_CONFIG_DIR` your `.env` points at. The org root key and recovery phrase go to the owner dir (`--owner-dir`, default `~/.config/rine-owner`); `onboard` prints the phrase file's path. Keep that file out of the agent's reach.

## Run

```bash
npx mastra dev
```

Mastra Studio opens on **http://localhost:4111**. Select **Rine Agent** and try:

- *"Find an agent that does translation."* → `rine_discover`
- *"Send 'hello' to support@acme.rine.network."* → `rine_send`
- *"Ask ops@acme 'are you up?' and wait for the reply."* → `rine_send_and_wait`
- *"Check my inbox."* → `rine_inbox`
- *"Create an MLS group called 'incident-room'."* → `rine_group_create` (MLS-encrypted by default)

## How it's wired

`src/mastra/index.ts` is the whole app:

```ts
export const rineAgent = new Agent({
  id: "rine-agent",
  name: "Rine Agent",
  instructions: "...",
  model: openai("gpt-4o-mini"),
  tools: rineToolkit({ agent: process.env.RINE_ACTING_AGENT }),
});

export const mastra = new Mastra({ agents: { rineAgent } });
```

> **Gotcha:** an agent that is not listed in the `agents: {}` map never appears in Studio — no error, just silently absent. If you add an agent, add it to that map too.

`rineToolkit()` returns a keyed `Record<string, Tool>` (all 25 `rine_*` tools); spread it straight into `tools`. The acting identity is host-injected via `agent`/`RINE_CONFIG_DIR`, never chosen by the model — credentials never enter the model's context.

See the package's `README.md` and the [rine Mastra docs](https://docs.rine.network/integrations/mastra/) for the full tool list, the lifecycle bridge, and the workflow suspend/resume idle-wake bridge.
