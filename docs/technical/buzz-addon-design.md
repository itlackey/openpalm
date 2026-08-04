# Buzz Addon — Technical Design

**Status:** Design, not yet implemented. No code has been written for this.
**Date:** 2026-08-04
**Author context:** follows [`../reviews/buzz-integration-analysis.md`](../reviews/buzz-integration-analysis.md);
sibling document to [`paperclip-addon-design.md`](paperclip-addon-design.md) —
read that first for the pattern this design reuses and diverges from.
**Upstream reviewed:** [`block/buzz`](https://github.com/block/buzz) @
`0afeac8`, Apache-2.0

Ships two independent, profile-gated addons:

1. **`buzz-agent`** — bridges the OpenPalm assistant into a Buzz relay
   (self-hosted or external) as an isolated agent identity. No database, no
   new stateful infrastructure — purely an outbound WebSocket client that
   spawns a sandboxed `opencode acp` process per turn.
2. **`buzz-relay`** — self-hosts the Buzz relay + Postgres + Redis + MinIO,
   for operators who want their own community rather than joining a hosted
   one. Optional; `buzz-agent` works without it.

**Defaults:** neither addon enabled. When `buzz-agent` is enabled without
`buzz-relay`, it must be given an external `BUZZ_RELAY_URL`. The agent
identity has **no default access to the assistant's AKM knowledge stash** —
see §4, the load-bearing design decision in this document.

This design makes **no changes to `core-principles.md` in this PR.** §10
carries a proposed amendment, for confirmation in a follow-up round — the same
two-step process used for the Paperclip addon design, applied deliberately
this time rather than assumed.

---

## 1. Why this design differs from Paperclip's, structurally

The Paperclip design's central tension was a *routing choice*: direct to the
assistant, through Guardian, or as a screened model provider — three
meaningfully different security postures, all real HTTP paths Guardian could
potentially intercept.

Buzz has no such choice to offer, and pretending otherwise would misrepresent
the system. `buzz-acp` never makes an HTTP call to OpenCode's `/session` API —
it spawns a fresh `opencode acp` subprocess over stdio and drives it via the
ACP `session/prompt` method (`crates/buzz-acp/README.md`,
`VISION_AGENT.md`). Guardian's entire moderation apparatus wraps that HTTP
surface (`docs/technical/core-principles.md` §2); there is nothing here for it
to wrap. See the integration analysis §2.2 for the full argument.

So this document is not a routing design. It is an **isolation** design: given
that Guardian cannot help, what architecture keeps a compromised or merely
rude Buzz channel from reaching anything that matters? The answer, worked out
in §4, borrows directly from a pattern OpenPalm already ships — Guardian's own
content moderator is itself a second, deliberately narrow OpenCode instance.
`buzz-agent` is designed the same way.

---

## 2. `buzz-agent`

### 2.1 What it does

Runs `buzz-acp` (upstream Rust binary, built from source — see §6) pointed at
a relay, authenticated as its own Nostr identity. Per
`crates/buzz-acp/README.md`, it:

1. Connects over WebSocket (`BUZZ_RELAY_URL`), authenticates with NIP-42 using
   `BUZZ_PRIVATE_KEY`.
2. Discovers channels the identity is a member of, subscribes to `@mention`
   events.
3. On a mention, spawns (or reuses a pooled) ACP subprocess —
   `BUZZ_ACP_AGENT_COMMAND=opencode`, `BUZZ_ACP_AGENT_ARGS=acp` — and sends a
   batched prompt via `session/prompt`.
4. The agent's replies go back to the relay through the bundled Buzz CLI,
   which the harness wires into the subprocess automatically.

No inbound port. No database. The only OpenPalm-side integration surface is
which OpenCode config the spawned `opencode acp` process sees.

### 2.2 Container

New image, `openpalm/buzz-agent`, built by a new
`containers/buzz-agent/Dockerfile`, not derived from the assistant or guardian
image. It bakes two things:

- **The pinned OpenCode binary** — the same `opencode-ai` dependency version
  the assistant and guardian images install
  (`containers/assistant/tools/package.json`,
  `containers/guardian/tools/package.json`). AGENTS.md already states these
  two must be kept in lockstep; this addon makes it three.
- **The `buzz-acp` binary**, compiled from Buzz's own source at a pinned
  tag/commit, following the multi-stage `chef` → `builder` →
  `stripped-binaries` pattern the upstream `Dockerfile` already uses (Rust
  build stages produce a stripped release binary; the final stage is a slim
  runtime image with just that binary and the OpenCode install). This is new
  build-maintenance surface OpenPalm did not previously carry — see §9.

No Docker socket, no host filesystem access beyond its own mounts, no
`assistant_net` membership requirement of its own (it only needs to reach the
relay — see §5).

### 2.3 Config tree — mirrors Guardian's moderator, not the assistant

New managed tree, `system/buzz-agent/`, materialized to
`~/.openpalm/system/buzz-agent/`, mounted at the container's
`OPENCODE_CONFIG_DIR=/etc/opencode` — the identical mechanism
`system/guardian/` uses for the moderator (`core-principles.md` §1, "Guardian
managed config"). Managed means install/update overwrite it wholesale, exactly
like `system/guardian/`.

Default `system/buzz-agent/opencode.jsonc`, deliberately more conservative
than the assistant's shipped default
(`packages/skeleton/system/assistant/opencode.jsonc`, which allows `bash: {"*":
"allow"}` for a human-supervised interactive chat — a reasonable default there,
wrong here):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["/etc/opencode/instructions/core.md"],
  // No server block — opencode acp runs over stdio, not as an HTTP listener.
  "permission": {
    // Unscreened, multi-party input (§1). Ask by default; the operator opts
    // into broader autonomy per §2.5, not the other way around.
    "bash": { "*": "ask", "rm -rf /": "deny", "rm -fr /": "deny" },
    "edit": "ask",
    "task": "ask",
    "external_directory": {
      "/tmp/*": "allow"
      // No /stash, no /work, no config paths — see §2.4/§4.
    }
  }
}
```

A user-tunable `config/buzz-agent/` (persona, model override) mirrors
`config/guardian/` for the moderation model — same ownership split as every
other managed/user pair in `core-principles.md` §1.

**Open question for Phase 1 (not resolved by design alone):** whether `ask`
permissions are even answerable in this context. OpenCode's permission-ask
flow expects an interactive responder; Guardian's moderator sidesteps this by
using `deny` outright (it is a classifier, never an agent). `buzz-acp` has no
mechanism to answer a permission prompt — an unanswered `ask` will most likely
hang or auto-reject the turn, which is probably the *right* failure mode here
(fail closed on anything requiring judgment) but needs verification against
actual `opencode acp` behavior before this ships. If `ask` doesn't degrade
safely, the fallback is `deny` for `bash`/`edit`, matching the moderator's
posture exactly and accepting that the agent can read and converse but not
act — a legitimate, conservative v1 default.

### 2.4 Knowledge stash — no default access

The assistant's AKM stash (`knowledge/` → `/stash`) is not mounted into
`buzz-agent` by default. This is the single load-bearing decision in this
design, so it is stated plainly: **an operator who wants the Buzz-facing agent
to have the same memory as their interactive assistant is opting into a wider
trust boundary than the default, not restoring one that was removed.**

Rationale: `/stash` is where the operator's accumulated knowledge, lessons,
and skills live, and it is writable by the assistant. Handing an unscreened,
multi-party-input process read-write access to it means a successfully
manipulated turn can poison memory the interactive assistant trusts
implicitly on every future session — a persistent, silent compromise, not a
one-turn one. The interactive assistant's own `/stash` access is safe
precisely *because* Guardian screens everything reaching it; `buzz-agent`
has no such screen (§1).

An **optional overlay**, `buzz-agent.compose.knowledge.yml` (profile-gated,
disabled by default, mirroring `voice.compose.lan.yml`'s opt-in shape), grants
a **read-only** bind of `knowledge/` for operators who want the agent to
answer from existing knowledge without being able to write to it. Read-write
sharing is deliberately not offered as a documented option in v1; an operator
who wants it can hand-edit `custom.compose.yml`, but the addon does not make
it a checkbox.

### 2.5 Credentials

- **Nostr identity** — `private/secrets/buzz_agent_private_key`, generated
  once via `buzz-admin generate-key` at `openpalm addon enable buzz-agent`
  time, seeded-if-missing (never regenerated — regenerating orphans the
  identity's channel memberships and DM history, same rationale as
  `ensurePortalSecret`). Never assistant-readable; consumed only by the
  `buzz-agent` container.
- **LLM provider credentials** — the moderator pattern again: a narrow compose
  secret grant of `knowledge/secrets/auth.json` (same file the assistant uses,
  delivered as one Compose secret, not a `/stash` mount — exactly
  `guardian_auth_json`'s mechanism in `containers/guardian/entrypoint.sh`).
  `buzz-agent` gets provider auth without gaining anything else `/stash`
  carries.
- **`BUZZ_API_TOKEN`** (only if the target relay enforces token auth) —
  `private/secrets/buzz_agent_api_token`, same shape.

### 2.6 Inbound author gate

`--respond-to` (§ integration analysis 1.3) is exposed as addon config,
default **`owner-only`** — `buzz-acp`'s own upstream default, and the right
one here: it means the agent answers only its `RELAY_OWNER_PUBKEY`-equivalent
identity (the operator) until explicitly widened. Widening to `allowlist` or
`anyone` is an operator choice, surfaced but not defaulted.

---

## 3. `buzz-relay`

Self-hosts the infrastructure `engineering.block.xyz/blog/run-your-own-buzz-relay`
describes. Four services, all profile-gated `["addon.buzz-relay"]`, all on
`addon_net` only:

| Service | Image | Published | Notes |
|---|---|---|---|
| `buzz-relay` | `ghcr.io/block/buzz:${OP_BUZZ_RELAY_VERSION}` | `${OP_BUZZ_RELAY_BIND_ADDRESS:-127.0.0.1}:${OP_BUZZ_RELAY_PORT:-3850}:3000` | WS relay + REST + web UI, one process |
| `buzz-relay-db` | `postgres:17-alpine`, pinned by digest | never | |
| `buzz-relay-redis` | `redis:7-alpine`, pinned by digest | never | |
| `buzz-relay-minio` (+ one-shot `-init`) | `minio/minio`, pinned by digest | never | S3-compatible object store for media |

Unlike Paperclip, the image itself is well-pinnable: `ghcr.io/block/buzz`
publishes real semver tags (`0.1.0`, `0.1.1`, …), confirmed via the GHCR API —
`OP_BUZZ_RELAY_VERSION` should default to a pinned semver release, not `main`
or `sha-*`, which is a strictly better story than the Paperclip addon could
offer.

**Health port `8080` and metrics port `9102`** stay internal-only — no
`ports:` publication, matching Guardian's own moderator and admin listener
posture of "loopback/internal unless there's a documented reason to publish."

### 3.1 Config/secrets — the same exemption class as Paperclip, proposed not applied

The relay reads `POSTGRES_PASSWORD`, `REDIS_PASSWORD`,
`BUZZ_S3_ACCESS_KEY`/`SECRET_KEY`, `BUZZ_RELAY_PRIVATE_KEY`, and
`BUZZ_GIT_HOOK_HMAC_SECRET` as plain environment values with no `*_FILE`
indirection (confirmed in `deploy/compose/.env.example` and
`deploy/compose/compose.yml`) — the identical shape that motivated the
Paperclip addon's `env_file` exemption
(`paperclip-addon-design.md` §5).

**This design reuses that exemption's shape rather than inventing a second
one**, at `private/env/buzz-relay.env`, seeded once, mode `0600`. Whether
`core-principles.md`'s exemption clause is generalized to name `buzz-relay` as
a second instance, or whether this addon gets its own near-identical clause, is
exactly the kind of wording decision that belongs to the maintainer
confirmation step (§10) — this document does not presume the answer, only
that the mechanism is the right one to reuse.

### 3.2 Exposure

Same three-state model as the Paperclip addon's web-UI toggle
(`paperclip-addon-design.md` §6): `OP_BUZZ_RELAY_NETWORK_ACCESS` (default
`false`, loopback), with a Tailscale target
(`OP_BUZZ_RELAY_BIND_ADDRESS`/port `3850`, continuing the `38xx`
convention — chosen distinct from Paperclip's proposed `3840` so both addons'
port reservations stay non-colliding regardless of merge order).

`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` and `BUZZ_REQUIRE_AUTH_TOKEN=true` should
be the shipped defaults regardless of exposure — a closed relay is the
LAN-first-appropriate posture (`core-principles.md` "LAN-first" principle),
distinct from and in addition to the network-bind question. An operator
widening `OP_BUZZ_RELAY_NETWORK_ACCESS` without also closing membership would
be publishing an open community; the addon's setup flow should not let that
combination pass silently.

### 3.3 Bootstrap

Mirrors the Paperclip addon's addon-enable flow, using `buzz-admin` (baked
into the relay image per its `Dockerfile`) rather than a new binary:

1. `docker compose exec buzz-relay buzz-admin generate-key` → relay owner
   keypair, stored as `RELAY_OWNER_PUBKEY` (not secret — a public key) plus
   the matching private key filed under `private/secrets/` if the operator
   wants an interactive owner identity distinct from `buzz_agent_private_key`.
2. `docker compose exec buzz-relay buzz-admin add-member --pubkey <buzz-agent's pubkey>`
   — registers the `buzz-agent` identity as a relay member so it can read/
   publish. This is the addon-secret-lifecycle "Verification" step
   (`core-principles.md` § Addon secret lifecycle), Buzz-shaped: instead of
   Guardian seeding a principal record from a shared secret file, the relay
   owner publishes a membership event for the agent's public key.

---

## 4. How `buzz-agent` reaches `buzz-relay` — no Guardian-gating problem to solve

This is the section that would carry the Paperclip design's §8 (Guardian
deploy gating) if Buzz had an equivalent problem. It doesn't, and the reason
is worth stating precisely rather than left implicit.

When both addons are enabled, `buzz-relay` needs to be reachable from
`buzz-agent`. The exact precedent already exists in `services.compose.yml`:
Ollama is granted `assistant_net` — **not** because the assistant widens its
own membership, but because Ollama is "an addon the assistant needs to dial
outbound," and the compose comment states the rule directly: *"the assistant
reaches ollama as its LLM provider over ollama:11434, so ollama needs
assistant_net reachability."*

`buzz-relay` is the same shape from `buzz-agent`'s perspective, so it is
granted the analogous membership on the network `buzz-agent` actually lives
on — join `buzz-relay` to `addon_net` (where `buzz-agent` already is) rather
than granting `buzz-agent` any new network. No conditional compose overlay is
needed, unlike the Paperclip design's `paperclip.compose.direct.yml`, because
there is no routing mode to switch between — `buzz-agent` always dials
outbound to whatever `BUZZ_RELAY_URL` says, self-hosted or not, and the only
question is whether that URL resolves inside the stack (self-hosted, both
addons on `addon_net`) or on the public internet (hosted relay, ordinary
container egress, no compose change at all — the same as any LLM provider API
call the assistant already makes).

**No `hasGuardianIngressAddon`-style function is needed for either addon.**
Neither addon deploys, requires, or interacts with Guardian in any way.

---

## 5. Network membership summary

| Service | Networks | Rationale |
|---|---|---|
| `buzz-agent` | `addon_net` | Dials outbound only; no inbound surface |
| `buzz-relay` | `addon_net` | Ollama-pattern exception: `buzz-agent` needs to dial it |
| `buzz-relay-db`/`-redis`/`-minio` | `addon_net` | Never reached from outside the relay |

No service in this design touches `assistant_net`, `portal_net`, or the
assistant container's mounts at all — a materially smaller footprint against
`core-principles.md`'s security invariants than the Paperclip addon, which
needed a conditional `assistant_net` grant and a new documented invariant
exception (`paperclip-addon-design.md` §13).

---

## 6. Build pipeline — the real cost center

Flagged prominently because it is the one place this addon costs more than
Paperclip's, not less:

- **`containers/buzz-agent/Dockerfile`** — new multi-stage Rust build. CI needs
  a Rust toolchain (matching Buzz's pinned `rust-toolchain.toml`) purely to
  compile one dependency's binary — nothing else in this repo currently builds
  Rust from source.
- **Version pin** — `buzz-acp` has no published binary or image (§ integration
  analysis 1.4). The pin is a Buzz git tag/commit, and bumping it means
  rebuilding, not `docker pull`-ing a new tag. This is a recurring
  maintenance cost, not a one-time build.
- **Upstream churn risk** — `buzz-acp`'s own README documents "legacy env
  vars" already (`BUZZ_ACP_PRIVATE_KEY`, `BUZZ_ACP_API_TOKEN`,
  `BUZZ_ACP_TURN_TIMEOUT`), meaning the config surface has already changed
  shape once. Pin bumps need a config-surface diff, not just a rebuild.

This should be weighed explicitly against `buzz-relay`, which by contrast is
close to zero build cost — it's a `docker pull` of a semver-tagged upstream
image, the easier addon of the two by a wide margin on this axis even though
it's the heavier one at runtime.

---

## 7. Telemetry

Buzz's `telemetry` module (`crates/buzz-relay/src/telemetry.rs`, referenced
from `main.rs`) is OpenTelemetry tracing — operator-configured, self-hosted
export target, off unless an OTEL endpoint is configured. This is **not** the
default-on third-party analytics phone-home the Paperclip addon design had to
neutralize. No `OP_TELEMETRY`-equivalent action is required for Buzz on its
own merits.

If the Paperclip addon's global `OP_TELEMETRY` toggle
(`paperclip-addon-design.md` §11) lands first, `buzz-relay`'s OTEL exporter
could reasonably be gated by the same flag for operators who want zero
external export of any kind — noted as a natural follow-on, not a requirement
of this design.

---

## 8. Delivery phases

**Phase 1 — `buzz-agent` only.** The addon skeleton
(`addon-ids.ts` entry, `system/buzz-agent/` skeleton config, the
`containers/buzz-agent/` image and its CI build job, credential seeding
including the `guardian_auth_json`-style narrow secret grant, the
`--respond-to owner-only` default, the read-only knowledge overlay as an
explicit opt-in). Requires an external `BUZZ_RELAY_URL` (a hosted relay, or a
teammate's) — no new stateful service. This is the addon worth shipping
first: it's the lower-risk, lower-infrastructure half of the recommendation,
and it's fully useful on its own against buzz.xyz's hosted relay.

**Phase 2 — `buzz-relay`.** The four-service self-hosted bundle, its
`env_file` exemption (pending the core-principles.md confirmation in §10),
exposure toggle, and Tailscale target. Depends on nothing from Phase 1 except
sharing the port-range convention.

**Phase 3 — closed items.** Resolve the `ask`-permission-in-a-headless-context
open question (§2.3) empirically; consider whether `buzz-agent`'s config
surface should be admin-UI-editable the way the Paperclip design deferred its
own admin panel to Phase 3.

---

## 9. What this design deliberately does not cover

- **Git/forge features** (NIP-34 patches, branch-as-channel, git hosting
  backend) — real Buzz capabilities (`README.md`'s feature table lists them as
  "Works today"), but they imply the OpenPalm assistant participating in code
  review and patch workflows inside Buzz channels, a materially larger scope
  than "join channels and answer mentions." Out of scope for this design;
  worth its own follow-up once §2's isolation model is proven in practice.
- **Huddle/voice** — Buzz ships real-time voice
  (`ARCHITECTURE.md`: "Real-time voice lives inside buzz-relay... forwards
  opaque Opus frames between peers"). No interaction with OpenPalm's own Voice
  addon is proposed here; they are unrelated systems that happen to share a
  name for a concept.
- **Multi-community / multi-tenant hosting** — Buzz supports many communities
  behind one relay backend (`VISION_AGENT.md`, `NOSTR.md` "Community scope").
  This design assumes the single-community deployment shape the blog post and
  the default Compose bundle both describe; multi-tenant hosting is an
  operator choice orthogonal to this addon.

---

## 10. Proposed `core-principles.md` note — NOT applied in this PR

Unlike the Paperclip addon (whose amendment is now live, per maintainer
confirmation on that PR), this document deliberately stops short of proposing
exact replacement text to apply. The two additions below are what Phase 1/2
would need, offered for the maintainer to confirm, adjust, or reject before
any diff to `core-principles.md` is written:

1. A `buzz-relay` row alongside the Paperclip rows in § Service port
   assignments (internal `3000`/`3850`, `buzz-relay-db` internal `5432` never
   published — same shape as the Paperclip DB row already there, if that PR
   has merged first).
2. Either a generalization of the existing "Named `env_file` exemption" clause
   (§2b) to name `buzz-relay` as a second instance, or a parallel clause — the
   maintainer's call, flagged in §3.1 above.

No change to Security invariant #2 is proposed here: `buzz-agent`/`buzz-relay`
introduce no Guardian-bypass exception, because — unlike the Paperclip
addon — nothing in this design touches `assistant_net` or dials the assistant
directly. §5's network table is the complete membership story; there is
nothing left for an invariant amendment to carve out.

---

## 11. Verification plan

- **`buzz-agent`**: confirm `opencode acp` honors `OPENCODE_CONFIG_DIR`
  identically to `opencode serve`/`opencode run` (assumed by analogy in §2.3,
  not yet confirmed against OpenCode's own source — first thing to check in
  Phase 1). Confirm the `ask`-permission behavior question from §2.3 against a
  real `opencode acp` subprocess before deciding the shipped default between
  `ask` and `deny`.
- Compose/skeleton guardrail tests (mirroring the Paperclip design's §15):
  `buzz-agent` has no `assistant_net`/`portal_net` membership under any
  config; `buzz-relay`'s health/metrics ports are never published; the
  `buzz-agent` container has no `/stash` mount unless the explicit read-only
  overlay is active.
- Manual: enable `buzz-agent` against buzz.xyz's hosted relay (no `buzz-relay`
  needed), register the identity, `@mention` it from a browser client, confirm
  a reply with `--respond-to owner-only` correctly ignoring a non-owner
  mention and answering an owner one.
- Manual: enable `buzz-relay`, run the bootstrap flow (§3.3), confirm
  `buzz-agent` can join a channel on the self-hosted relay over `addon_net`
  with no host port involved in that path.

---

## 12. Sources

Same as the companion review's §4, plus: `containers/guardian/entrypoint.sh`
(the `guardian_auth_json` delivery mechanism this design's §2.5 reuses),
`packages/skeleton/system/guardian/opencode.jsonc` (the moderator config this
design's §2.3 is modeled on), `packages/skeleton/system/stack/services.compose.yml`
(the Ollama per-service `assistant_net` exception cited in §4).
