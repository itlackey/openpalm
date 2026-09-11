# OpenPalm × Buzz — Integration & Strategy Analysis

**Date:** 2026-08-04
**OpenPalm revision reviewed:** `01161de` (main), MPL-2.0
**Buzz revision reviewed:** `0afeac8` (master, 2026-08-04), Apache-2.0 —
[`block/buzz`](https://github.com/block/buzz)

**Scope:** what Buzz is, how it differs architecturally from
[Paperclip](https://github.com/paperclipai/paperclip) (see the companion
[`paperclip-integration-analysis.md`](paperclip-integration-analysis.md)), and
how OpenPalm should integrate with it for the same "AI agents at work" business
use case.

**Method:** Buzz was cloned and read at source — `README.md`, `ARCHITECTURE.md`,
`VISION_AGENT.md`, `NOSTR.md`, `crates/buzz-acp/README.md`,
`deploy/compose/{README.md,compose.yml,.env.example,run.sh}`, and the root
`Dockerfile` — not from the launch blog post or press coverage. Every claim
below cites a path in the cloned tree. Where something is inferred rather than
directly verified in source, it is labelled as such.

---

## Summary

**Buzz is not "another Paperclip."** Paperclip is a control plane that
orchestrates agents through their existing runtimes (CLI subprocess, SSH,
sandbox). Buzz is a **communication substrate** — a self-hostable Nostr relay
where humans and agents share the same channels, and where agents are just
another kind of member with their own cryptographic identity. From
`README.md`: *"Agents are part of the room, not haunted cron jobs."*

The headline finding, verified against source: **OpenCode already speaks the
protocol Buzz's agent bridge expects.** `buzz-acp` (`crates/buzz-acp/README.md`)
is a generic harness that spawns *any* ACP-compliant binary over stdio — it
lists goose, `codex-acp`, and `claude-agent-acp` as supported runtimes, and
OpenCode ships a first-party `opencode acp` subcommand (confirmed via
OpenCode's own docs at `opencode.ai/docs/acp` and DeepWiki's ACP writeup — no
OpenPalm-authored adapter package is required the way Paperclip's integration
needed one. This inverts the Paperclip finding: there, the missing piece was on
OpenPalm's side (an adapter package that doesn't exist yet); here, the missing
piece is on OpenPalm's side too, but it's *build tooling*, not *protocol
support* — see §3.

**Recommendation:** ship two independent addons — `buzz-agent` (join any Buzz
relay, hosted or self-hosted, as an isolated agent identity) and `buzz-relay`
(self-host the relay infrastructure the blog post describes). `buzz-agent` is
the higher-leverage, lower-risk addition and should land first.

---

## 1. What Buzz actually is

A single Rust binary (`buzz-relay`) that serves a WebSocket Nostr relay, a REST
API, and a web UI from one process (`README.md` Quick Start). It requires
Postgres, Redis, and an S3-compatible object store
(`deploy/compose/compose.yml`). Apache-2.0, self-hostable, with a hosted
alternative at buzz.xyz.

### 1.1 The protocol: Nostr, not a bespoke API

Buzz is built on Nostr — "every message, reaction, workflow step, review
approval, and git event is a signed event in one log" (`README.md`). It speaks
NIP-29 (relay-based groups) and NIP-42 (auth) natively; third-party Nostr
clients can connect directly (`NOSTR.md`). Identity is asymmetric-key based: an
npub/nsec keypair, not an OAuth token or a Guardian-style Basic-auth secret.
This is the single deepest architectural difference from Paperclip, which uses
conventional server-issued credentials throughout.

### 1.2 The domain model: rooms, not org charts

Where Paperclip's unit is the **company** (goals, org chart, budgets),
Buzz's unit is the **channel** — closer to a Slack/Discord model, but with git
branches treated as channels natively (NIP-34 patches, `README.md`'s "Branch as
room" story) and with humans and agents as symmetric channel members.
There is no budget system, no issue-checkout-lock execution model, no approval
workflow engine comparable to Paperclip's — Buzz's own README table
(`README.md` "Works today · Being wired up · Strong opinions, pending code")
lists "Workflow approval gates" as 🚧 *being wired up*, not shipped.

### 1.3 The agent bridge: `buzz-acp`

`crates/buzz-acp/README.md` describes the mechanism precisely:

```
Buzz Relay ──WS──→ buzz-acp ──stdio──→ Your Agent
                                               │
                                          Buzz CLI
                                       (send_message, etc.)
```

`buzz-acp` connects to a relay over WebSocket using a Nostr keypair
(`BUZZ_PRIVATE_KEY`), discovers the channels that identity is a member of,
listens for `@mentions`, and on each one spawns (or reuses a pooled) ACP
subprocess, feeding it a batched prompt via `session/prompt`. The agent's
replies use a bundled CLI (`send_message`, `get_messages`, etc.) to write back
to the relay. It is explicitly protocol-native and adapter-free: *"The agent
does not know what MCP server it talks to... They compose through protocols,
not imports"* (`VISION_AGENT.md`).

Configuration of note, all from `crates/buzz-acp/README.md`:

- `BUZZ_ACP_AGENT_COMMAND` (default `goose`) / `BUZZ_ACP_AGENT_ARGS` (default
  `acp`) — the binary and args to spawn. Pointing this at `opencode acp` is a
  configuration change, not new code.
- `--respond-to {owner-only|allowlist|anyone|nobody}` (default **`owner-only`**)
  — a coarse *who can trigger the agent* gate, applied before any content ever
  reaches the spawned process.
- `--agents N` (1–32, default 1) — a pool of concurrent subprocess instances,
  all sharing **one Nostr identity** ("users see one bot regardless of how many
  agents are running").
- `BUZZ_ACP_IDLE_TIMEOUT` / `BUZZ_ACP_MAX_TURN_DURATION` — bounded turn
  lifetime, a real safety property, not just a knob.

### 1.4 Distribution

Buzz publishes real semver image tags on `ghcr.io/block/buzz`
(`0.1.0`, `0.1.1`, …, confirmed via the GHCR tags API), plus `main` and
`latest`. This is a materially better pinning story than Paperclip, which
publishes only `latest` and `sha-<commit>`.

**The relay image does not contain `buzz-acp`.** Its Dockerfile
(root `Dockerfile`) bakes exactly three binaries into the runtime image:
`buzz-relay`, `buzz-admin`, `buzz-pair-relay`. `buzz-acp` ships as source only —
an operator builds it with `cargo build --release -p buzz-acp`. There is no
published `ghcr.io/block/buzz-acp` image (confirmed: GHCR returns `DENIED` for
that repository path). This is the reverse of Paperclip's situation and matters
a great deal for effort estimation — see §3.

---

## 2. Nuances vs. Paperclip — and how they change the plan

Six differences that each independently change the shape of an OpenPalm addon,
relative to the Paperclip design
(`docs/technical/paperclip-addon-design.md`):

### 2.1 No adapter package is needed — a build pipeline is, instead

Paperclip's blocker was protocol: its built-in adapter spawns the OpenCode CLI
as a subprocess and has no way to drive a remote OpenCode HTTP server, so
OpenPalm needed to author `@openpalm/paperclip-adapter` from scratch before
direct integration was possible at all.

Buzz has no equivalent gap — `opencode acp` already exists. What Buzz needs
instead is infrastructure OpenPalm must build and maintain: a container image
that compiles `buzz-acp` from the upstream Rust source (multi-stage build,
mirroring Buzz's own `chef`/`builder`/`stripped-binaries` Dockerfile pattern),
pinned to a Buzz release tag, rebuilt on every version bump. This is a
different *kind* of cost — ongoing Rust-toolchain build maintenance rather than
a one-time TypeScript package — and it should be sized as such.

### 2.2 Guardian cannot mediate this traffic at all — by construction, not by choice

This is the most consequential finding in this document.

Guardian's entire security model — principal auth, ownership, rate limits,
content validation — wraps a **transparent HTTP proxy in front of OpenCode's
`/session` API** (`docs/technical/core-principles.md` §2). It works by
intercepting an HTTP `POST /session/{id}/message` call before it reaches
OpenCode.

`buzz-acp` never makes that call. It spawns a fresh OpenCode process over
**stdio** and feeds it a prompt directly via the ACP `session/prompt` method —
there is no HTTP hop anywhere in the path for Guardian to intercept. Where
Paperclip's design offered a real routing choice (`direct` vs. `guardian`, with
Guardian's content validation as the payoff for choosing it), **that choice
does not exist for Buzz.** No compose topology, no network overlay, no routing
env var can put Guardian in this path, because Guardian mediates a protocol
Buzz's bridge doesn't use.

The practical consequence: every message from every Buzz channel member the
agent is exposed to reaches the agent's context with **zero** content
screening beyond whatever `--respond-to` and OpenCode's own `permission` block
provide. This is a strictly worse starting position than even Paperclip's
`assistant` (unscreened, direct) routing mode, because Paperclip's design at
least made unscreened access an explicit operator choice with a screened
alternative sitting right next to it. See §2.3 for the mitigation this pushes
toward.

### 2.3 The mitigation is architectural isolation, not a routing toggle — closely mirroring Guardian's own moderator pattern

Since there is no protocol-level screening lever, the design in this PR leans
on a pattern OpenPalm already ships: **Guardian's own content moderator is a
second, narrowly-scoped OpenCode instance**, not the assistant's. Verified in
`containers/guardian/entrypoint.sh`: the moderator gets its own managed config
tree (`system/guardian/` → `OPENCODE_CONFIG_DIR`), and provider credentials
arrive as a narrow compose secret (`guardian_auth_json`, installed to
`~/.local/share/opencode/auth.json` on boot) rather than the assistant's full
`knowledge/secrets/auth.json` `/stash` mount.

The addon design in this PR's companion document proposes the identical shape
for `buzz-agent`: its own managed config tree, its own (more restrictive)
default permission set, its own identity, and — critically — **no default
access to the assistant's AKM knowledge stash**, so a channel member who
successfully manipulates the agent reaches a sandboxed identity with a narrower
blast radius than the interactive assistant, rather than the interactive
assistant itself. This is not something Paperclip's design needed, because
Paperclip's worst case (`assistant` routing) still went through the assistant's
own already-running, already-configured OpenCode server.

### 2.4 The relay is genuinely optional infrastructure — Paperclip's control plane isn't

An operator can point `buzz-acp` at buzz.xyz's hosted relay, or at a
teammate's self-hosted one, and get the full agent-membership experience with
**zero new containers** in the OpenPalm stack. Paperclip has no equivalent
lightweight mode — "your Paperclip" is inherently something you run for
yourself. This argues for splitting the capability into two independent
addons rather than one bundled service, unlike Paperclip's single `paperclip` +
`paperclip-db` pair. See the companion design doc §3.

### 2.5 The self-hosted relay is heavier infrastructure than Paperclip, when chosen

If an operator *does* self-host (the scenario the blog post that prompted this
review is literally about), the footprint is four services — relay, Postgres,
Redis, MinIO (S3) — against Paperclip's two (app, Postgres). Verified in
`deploy/compose/compose.yml`. Same `env_file`-exemption shape applies (the
relay reads `POSTGRES_PASSWORD`, `REDIS_PASSWORD`,
`BUZZ_S3_ACCESS_KEY`/`SECRET_KEY`, `BUZZ_RELAY_PRIVATE_KEY`, and
`BUZZ_GIT_HOOK_HMAC_SECRET` as plain environment values with no `*_FILE`
indirection, confirmed in `deploy/compose/.env.example`), but with more
values to manage.

### 2.6 Identity is self-sovereign and portable — Guardian's principal model is not

A Guardian principal is meaningless outside one OpenPalm install; rotating a
secret is a local file operation. A Buzz agent identity (npub/nsec) is a
portable cryptographic keypair that can join *multiple* communities and is
independently verifiable by anyone holding the public key — Buzz enforces this
explicitly: *"membership, jobs, DMs, profile, and presence [are] still scoped
to the community behind that URL... no agent state is inherited across hosts"*
(`VISION_AGENT.md`), but the **key itself** is portable in a way a Guardian
principal secret was never designed to be. Practically: back up
`private/secrets/buzz_agent_private_key` like any other credential, but be
aware — unlike a Guardian principal secret — this key's public half may already
be known to other Buzz communities the operator has joined it to.

---

## 3. Recommendation

Two independent, profile-gated addons:

1. **`buzz-agent`** — the `buzz-acp` bridge, pointed at any relay
   (`BUZZ_RELAY_URL`, self-hosted or external). Ships first: no new stateful
   infrastructure, no database, purely outbound. The real cost is the custom
   build pipeline (§2.1), not runtime design.
2. **`buzz-relay`** — self-hosts the relay + Postgres + Redis + MinIO for
   operators who want their own community, matching the blog post this review
   is responding to. Optional; `buzz-agent` works without it.

Full technical design, including the exact compose shape, the
`system/buzz-agent/` config tree, the credential-delivery mechanism, and a
proposed (not yet applied) `core-principles.md` note, is in the companion
document: [`../technical/buzz-addon-design.md`](../technical/buzz-addon-design.md).

---

## 4. Sources

**OpenPalm** (`01161de`): `docs/technical/core-principles.md`,
`containers/guardian/entrypoint.sh`,
`packages/skeleton/system/stack/services.compose.yml` (the Ollama
per-service `assistant_net` exception).

**Buzz** (`0afeac8`): `README.md`, `ARCHITECTURE.md`, `VISION_AGENT.md`,
`NOSTR.md`, `crates/buzz-acp/README.md`, `Dockerfile`,
`deploy/compose/{README.md,compose.yml,.env.example,run.sh}`.

**External** (verified independently, not from press coverage): OpenCode's own
`opencode acp` subcommand — `opencode.ai/docs/acp` and DeepWiki's
`sst/opencode` ACP writeup; GHCR tag listings for `block/buzz` and
`block/buzz-acp` via the GHCR v2 API.
