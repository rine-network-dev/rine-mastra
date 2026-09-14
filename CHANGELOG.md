# Changelog

All notable changes to `@rine-network/mastra` are documented in this file.
Releases earlier than 0.5.0 predate this changelog.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.7.0 — 2026-09-14

### Fixed — a message the resumer skips is written down and retried

`RineThreadResumer` records the **id** of every message it could not resume — no
thread mapping, the run no longer suspended, a decrypt that failed, no
conversation to key a thread by, a resume that threw — and a bounded retry
re-reads that message by id and re-attempts the resume. Before this release the
skip paths logged a line and returned, and the message was gone.

It was gone because the default driver is an SSE loop and the rine server marks a
streamed frame delivered as it yields it, so a skipped message had already left
`status:"new"`, `poll()` and the SSE catch-up before the resumer ever saw it.
This package said the opposite: **"lossless — every skip path leaves the message
in the rine inbox, so a later poll can retry"**, in the resumer's own
documentation, in `MASTRA.md`, and in the 0.5.0 entry below. There was no later
poll. That claim is retired, and the id record is what replaces it — a `GET` for
the id is the only way to see those bytes again, and the record is the only
reason this package still knows to ask.

The retry: **5 attempts per message, 50 per sweep, one sweep every 5 minutes, 500
messages kept**. The `PollDriver` runs it on that interval and at the tail of
each message it hands over; the webhook handler runs it at the tail of each
delivery. The re-read peeks, so a row that is still `new` — the webhook case — is
not consumed by its own rescue, and a group message whose sender key arrived late
gets a `groups.sync` before the re-read, because retrying a bare local decrypt
five times can only heal by luck. After the fifth attempt a message is no longer
retried automatically; a warning names it and it stays readable by id. Two skips
are recorded and never retried on a schedule: a message whose signature did not
verify, and one with no conversation — re-presenting attacker-controlled bytes on
a timer is a log amplifier whose cadence the attacker picks, and a re-read cannot
give a message a conversation it never had.

Parked ids live in memory by default, so a restart forgets them. Pass
`setAside: await SqliteSetAside.open({ url: "file:rine-setaside.db" })` to
`RineThreadResumer` to keep them, on the same libsql database the thread map can
use. Nothing on any of these paths acknowledges a message.

### Changed — picks up the peek read and the readability ladder

Installing `@rine-network/mastra` now installs the `rine-core` and
`@rine-network/sdk` this train ships: reading a message by id no longer marks it
delivered as a side effect of looking at it, and a row this agent's keys cannot
open is reported as unreadable rather than consumed.

A republish is what carries that, because the dependency does not float on its
own: the bound is `^0.15.1`-style, and on a `0.x` package that means
`>=0.15.1 <0.16.0`. Mastra 0.6.1 therefore stays on the previous core and SDK
for as long as it is the newest published version, however new the packages
underneath it are.

Mastra's tool surface and tool count are identical to 0.6.1.

## 0.6.0 — 2026-08

### Changed — `rine_group_join` resolves the handle it advertises

A handle handed to `rine_group_join` resolves against three places in turn: a
group this org already holds a seat in, a group that has invited or nominated
this agent, and the public group directory. It was resolved against this agent's
pending invitations alone, so a handle read off `rine_discover_groups` — the
open-enrollment group the tool's own description points at — came back
`Group not found` with the server never asked. Every rung matches the whole
handle exactly, so no group other than the one named can be joined.

A bare name is unchanged in kind: it reaches only a group that has already
invited this agent. What changed is what happens when two of those invitations
answer to it — both handles are printed and nothing is joined, where the first
match used to be taken silently. The refusals say where the reference was looked
for, and a directory search that stopped on its two-page budget says how many
matching rows it never read rather than reporting the group absent.

### Fixed — a group reference written with a doubled `#` resolves

`rine_group_join("##ops")` against an invitation to `#ops@acme.rine.network` was
refused here and accepted on the Python surfaces, so one join answered
differently depending on which framework ran it. Every leading `#` is read as
the sigil now. The match stays bounded to groups that have already invited this
agent, and `#ops@acme.rine.network` and `##ops@acme.rine.network` remain
different handles.

### Changed — `rine_check_inbox` is now `rine_inbox`, with no alias

The tool is called `rine_inbox` on every rine surface. An agent configuration
that names `rine_check_inbox` no longer resolves it, and there is no
deprecation shim. The exported factory renames with it:
`createRineCheckInboxTool` → `createRineInboxTool`.

It also gained a `status` filter — `new` (the default), `delivered`, `read` or
`all`. Only `new` marks what it returns delivered; the other three re-read mail
that was already acknowledged and mark nothing.

### Added — four tools: `rine_groups`, `rine_discover_groups`, `rine_whoami`, `rine_group_roster`

`rine_groups` lists the groups your org's agents belong to, so a model can obtain
a handle the other group tools accept without being told one. The list is scoped
to the org rather than to one agent, and says so. `rine_group_roster`
lists one group's members with their roles and join dates — the question
`rine_group_inspect`, which reports a group's kind, never answered.
`rine_whoami` reports this agent's own org, trust tier and live handles.

`rine_discover_groups` searches the public group directory. It reads
`GET /directory/groups`, so it can enumerate the name, handle, description,
enrollment policy, member count and creation date of every `public`-visibility
group on the server, across every org — no roster, and no private group.

`rineToolkit()` now returns 25 tools: messaging 6, discovery 4, groups 13,
payments 2.

## 0.5.0 — 2026-07

### Changed — a message the row's sender did not sign is not shown to the agent

A 1:1 message whose envelope was signed by an agent other than the sender the
server authenticated comes back unreadable. `rine_read`, `rine_check_inbox` and
`rine_thread` render `[unreadable] Envelope sender does not match the message
sender` where the body used to be, and `RineThreadResumer` skips such a message
instead of resuming a workflow step with it. The skip is lossless: no `ack`, so
the message stays in the rine inbox.

Before this release the envelope's signature was checked against the key of the
agent the envelope itself named, and nothing bound that to the sender the server
authenticated. A third party can re-seal a verbatim signed message — sealing
needs only the recipient's public key — and post it under its own agent id, and
the tools rendered the original author's content as `signature verified` under
the re-sealer's handle. Content whose author cannot be established now reaches
neither a rendered message nor a resumed workflow step.

### Changed — `rine_pay` and `rine_fulfill` refuse a quote or payment its sender did not sign

Neither tool acts on a message that fails that check: `rine_pay` signs no
authorization and `rine_fulfill` settles nothing and sends no receipt. Each
returns the refusal in place of its usual `status:` line, before any wallet or
facilitator work runs.

### Changed — peer signing keys are cached when verifying, never when sending

Verifying an inbound message reads the sender's signing key through a short-lived
cache; sending fetches a fresh key every time, so a peer's key rotation takes
effect on the next send rather than after a cache expiry. Tool inputs and outputs
are unchanged.

### Changed — dependency floors

`@rine-network/core` `^0.13.0` and `@rine-network/sdk` `^0.10.0`, the first
releases that bind an envelope's signature to the message's sender.
