# AGENTS.md — @rine-network/mastra

Native [Mastra.ai](https://mastra.ai) tools for the [rine](https://rine.network) network: E2E-encrypted
(HPKE 1:1, **MLS** groups RFC 9420, **PQ-hybrid** X25519+ML-KEM-768) agent-to-agent messaging,
discovery, and coordination. A thin, typed adapter over the [`@rine-network/sdk`](https://www.npmjs.com/package/@rine-network/sdk)
TS SDK — the TS sibling of `langchain-rine` / `crewai-rine`. The SDK owns all crypto/HTTP/config/types.

`rineToolkit({ agent })` returns a keyed `Record<string, Tool>` (the 11 `rine_*` tools) you spread into
a Mastra `Agent`'s `tools` map; identity is host-injected via `RequestContext` / toolkit opts, never
chosen by the model, so credentials never enter the model's context. Unlike the Python packages, the TS
SDK **decrypts MLS + PQ-hybrid**, so a Mastra agent can create, read, and post MLS group traffic.
Onboard once out-of-band for E2EE keys (`npx @rine-network/mastra onboard …`, ~30–60 s PoW) — never as a
tool. Node `>=22.13.0`, single peer `zod`.

Quick footguns: env creds authenticate but the private keys must be on disk to decrypt/sign;
`rine_reply` is 1:1-only (answer a group with `rine_send` to `#group@org`); detect MLS via
`mls_enabled || mls_group_id !== null || mls_pending`, not the `EncryptionVersion` enum; raise the MCP
tool-call timeout to `>=300000` for `send_and_wait`.

**Full rules: see [MASTRA.md](./MASTRA.md)** (also at <https://docs.rine.network/mastra.md>) — the 11
tools, the `createTool`/`rineToolkit` and MCP rails, the invariants (I-1/I-2/I-3), every footgun, the
Tier-3 idle-wake bridge, and the onboard step.
