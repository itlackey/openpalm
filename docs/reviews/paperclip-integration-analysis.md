# OpenPalm × Paperclip — Integration & Strategy Analysis

**Date:** 2026-08-04
**OpenPalm revision reviewed:** `155c235` (main, v0.13.0-beta.15), MPL-2.0
**Paperclip revision reviewed:** `2ab797d` (master, 2026-08-03, tagged
`canary/v2026.804.0-canary.5`), MIT — [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip)

**Scope:** what Paperclip is, where it overlaps and where it complements
OpenPalm, and how OpenPalm should be positioned and extended to serve the "AI
agents at work" business use case Paperclip targets.

**Method:** both repositories were read at source. Paperclip was cloned and its
adapter contract, execution semantics, MCP governance model, and deployment
modes were read directly rather than taken from marketing copy. Every claim
below cites a file path in one of the two trees. Where something is a judgement
call rather than a verified fact, it is labelled as such.

---

## Summary

**Thesis: OpenPalm should be the employee, not the company.**

Paperclip's own positioning is *"If OpenClaw is an employee, Paperclip is the
company"* (`README.md`). It is deliberately runtime-agnostic — it already ships
fourteen adapter types, loads more from npm without a fork, and its motto is
*"If it can receive a heartbeat, it's hired."* That leaves the employee slot
open, and OpenPalm fits it unusually well.

The complementarity is close to exact. The three capabilities OpenPalm has that
Paperclip does not are the same three Paperclip has declared out of scope or
unbuilt:

1. **Persistent memory and knowledge** — OpenPalm ships AKM; Paperclip's
   `doc/memory-landscape.md` is a survey of *other people's* memory systems and
   `README.md` lists memory under **Planned**.
2. **Human conversation channels** — OpenPalm ships web chat, Discord, Slack,
   voice, a PWA, and an Electron desktop app; Paperclip's `README.md` says
   plainly it is **not** "a chatbot interface," and lists a desktop app under
   **Planned**.
3. **Fail-closed ingress moderation** — Guardian screens every prompt-bearing
   request and blocks on moderator failure; Paperclip has trust presets
   (`doc/LOW-TRUST-PRESETS.md`) but no equivalent content-validation gate.

Conversely, everything OpenPalm lacks for team use — org charts, an issue graph,
budgets with hard stops, heartbeat execution with recovery semantics,
multi-human boards — is Paperclip's core, and is far more mature than a
reasonable OpenPalm roadmap could reach.

**Recommendation, in order:**

| Phase | Work | Effort | Risk to OpenPalm invariants |
|---|---|---|---|
| **0** | Wire the two together with configuration only — Guardian's compatible API as a Paperclip provider; MCP in both directions | days | none |
| **1** | Build three OpenPalm-side enablers that are valuable standalone: principal management UI, per-principal usage accounting, a trusted-principal class | 1–2 weeks | one new `/api/host/*` family; one documented moderation exception |
| **2** | Publish `@openpalm/paperclip-adapter` as an external npm plugin implementing Paperclip's `ServerAdapterModule` over Guardian `/oc/*` | 2–4 weeks | none in OpenPalm core |
| **3** | *(optional)* Workspace overlay for code-capable roles | — | one new optional Compose overlay |

**Do not** rebuild Paperclip's control plane inside OpenPalm. Specifically, do
not add multi-user human accounts or RBAC — that collides directly with
OpenPalm's stated security invariants and with Paperclip's core competency.

---

## 1. What Paperclip actually is

A Node.js 20 server plus a React UI over PostgreSQL, MIT-licensed, self-hosted,
installed by `curl -fsSL https://paperclip.ing/install.sh | bash` or
`pnpm install && pnpm dev` (API on `:3100`, embedded Postgres by default).

It describes itself as "the control plane for autonomous AI companies"
(`doc/PRODUCT.md`). One deployment hosts many **companies**; each company has a
goal, an org chart of agent (and human) employees with reporting lines, a
budget, and a work hierarchy where — per `doc/PRODUCT.md` — "every piece of work
must trace back to the company's top-level goal through a chain of parent
tasks."

### 1.1 The subsystems that matter here

**Agents are adapters.** `server/src/adapters/builtin-adapter-types.ts` lists
the shipped set:

```
acpx_local, claude_local, codex_local, cursor_cloud, cursor, gemini_local,
grok_local, hermes_gateway, hermes_local, openclaw_gateway, opencode_local,
pi_local, process, http
```

An adapter is one interface — `ServerAdapterModule` in
`packages/adapter-utils/src/types.ts:419`:

```ts
export interface ServerAdapterModule {
  type: string;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
  listSkills?, syncSkills?, sessionCodec?, sessionManagement?,
  models?, listModels?, getConfigSchema?, detectModel?, getQuotaWindows?, …
}
```

`execute` receives a run id, the agent record, prior session params, config, and
callbacks (`onLog`, `onEvent`, `onMeta`, `onRuntimeProgress`); it returns exit
status plus `usage` (input/output/cached tokens), `costUsd`, `model`,
`billingType`, and `sessionParams` for the next wake. That last field is how
Paperclip gets session continuity across heartbeats without the adapter holding
state.

**External adapters need no fork.** `server/src/adapters/plugin-loader.ts`
loads adapter packages from an on-disk plugin store (npm package or `file:`
path), and `docs/adapters/external-adapters.md` documents the package layout,
`package.json` shape, and the dynamically-loaded UI transcript parser. This is
the supported extension path and the one this analysis recommends.

**Execution is heartbeat-driven, and the semantics are hard-won.**
`doc/execution-semantics.md` separates structure (`parentId`), dependency
(`blockedByIssueIds`), ownership, and execution, then defines: checkout locks
(`checkoutRunId` vs `executionRunId`) with compare-and-clear finalization;
a liveness contract forbidding any non-terminal agent-owned issue from having
no next move; bounded recovery for stranded `todo` and stranded `in_progress`;
one-shot issue monitors with `nextCheckAt`; a silent-active-run watchdog that
classifies output silence as `ok`/`suspicious`/`critical`; a task watchdog for
stalled subtrees capped at three mutations per recovery batch; and a three-tier
escalation (auto-recover → explicit recovery action → human).

This is the part that would be expensive and slow to reproduce, and it is the
main reason the recommendation below is "integrate," not "absorb."

**MCP tool access is governed, not just proxied.** `doc/MCP-ACCESS-GOVERNANCE.md`
defines Application → Connection (`remote_http` or `local_stdio`) → Catalog
Entry (each tool risk-classified `read`/`write`/`destructive`) → Profile
(allow/deny bundles) → Binding (to company/agent/project/routine/issue) →
Policy (`allow`, `block`, `require_approval`, `rate_limit`, `trust_rule`, deny
beats allow) → Gateway decision → Call Event audit log → Action Request for
human approval.

**Paperclip is also an MCP server.** `packages/mcp-server/src/tools.ts` exposes
41 tools to agents — `paperclipListIssues`, `paperclipCheckoutIssue`,
`paperclipUpdateIssue`, `paperclipAddComment`, `paperclipGetHeartbeatContext`,
`paperclipSuggestTasks`, `paperclipAskUserQuestions`,
`paperclipRequestConfirmation`, `paperclipApprovalDecision`,
`paperclipApiRequest`, and so on. This is how an agent participates in the
company from inside its own runtime.

**Deployment modes mirror OpenPalm's philosophy.**
`doc/DEPLOYMENT-MODES.md` defines `local_trusted` (loopback, no login) vs
`authenticated` (`private` or `public`), with bind treated as a separate
concern: `loopback | lan | tailnet | custom`. OpenPalm's flat `access` booleans
(`packages/lib/src/control-plane/access-toggles.ts`) express the same idea.

### 1.2 What Paperclip says it is not

From `README.md`, verbatim: not a chatbot interface, not an agent-building
framework, not a drag-and-drop workflow builder, not a prompt management tool,
not a single-agent productivity tool, not a code review platform.
`doc/PRODUCT.md` adds: not a Jira/GitHub replacement, and enterprise RBAC is
explicitly not prioritised.

### 1.3 Roadmap position

`README.md` marks as **completed**: plugin system, OpenClaw integration, org
import/export, skills studio, scheduled routines, budgets, reviews and
approvals, multiple human users, sandbox agents, MCP tool gateway.
**In progress**: cloud multi-tenant. **Planned**: memory/knowledge systems,
work queues, self-organization, desktop app, third-party ticket integration.

---

## 2. What OpenPalm is, in the terms that matter here

Verified against `docs/technical/core-principles.md` (marked authoritative),
`docs/technical/design-intent.md`, and the source.

OpenPalm is a **host control plane over a Docker Compose stack** — "simply a set
of conventions used to manage Docker compose overlay files, .env files, and
configuration files." All state lives under `OP_HOME` (`~/.openpalm/`), split by
ownership: `config/` (user), `system/` (release-managed, overwritten),
`state/` (app-written), `knowledge/` (assistant-readable at `/stash`), `data/`,
`workspace/`, `private/` (delegated secrets, never in `/stash`), `cache/`.

**One always-on container**, the assistant: OpenCode on `:4096`, the baked
`@openpalm/ui` on `:3000`, BusyBox `crond`, and `akm tasks sync` every 60s.

**Guardian** (`packages/guardian/`) is profile-gated — deployed only when
`chat`, `api`, `discord`, `slack`, or `gateway` is enabled
(`packages/lib/src/control-plane/addon-ids.ts`). It is a **transparent 1:1
native OpenCode reverse proxy** with fail-closed overlays: HTTP Basic principal
auth, SQLite-persisted session and permission ownership
(`src/ownership.ts`, `src/state-db.ts`), tenant-filtered event fan-out, rate and
resource limits, and content validation via a loopback OpenCode moderator that
**blocks when it cannot classify** (`src/moderation.ts`, `src/content-screen.ts`).

**Identity is per-principal, not per-user.** The `principals` table is
`(id, kind ∈ {portal,direct}, label, token_hash, enabled, created_at)`
(`src/state-db.ts:209`). `core-principles.md` §2 is explicit: `x-openpalm-user`
"is an assertion by an already-authenticated portal principal, so isolation is
between principals rather than between every end user behind one portal." The
host UI uses a **single shared login password** with stateless HMAC session
tokens (`packages/ui/src/lib/server/session-store.ts`). There are no user
accounts, roles, or organisations anywhere in the codebase.

**Three extension points, and only three** (`design-intent.md`): Compose addons;
standard OpenCode assets mounted from `system/assistant/` and `config/assistant/`;
AKM task files in `knowledge/tasks/` run by cron.

**Existing outward-facing seams:**

| Seam | Where | State |
|---|---|---|
| OpenAI/Anthropic-compatible API | `packages/guardian/src/openai-api*.ts`, `127.0.0.1:3821` | shipped |
| MCP server | `packages/guardian/src/mcp.ts`, Bearer-auth | shipped, **exactly one tool**: `ask_assistant` (`mcp.ts:154`) |
| MCP client | `packages/skeleton/system/assistant/opencode.jsonc` — commented `mcp` block, "consume-only" | shipped, config-only |
| Principal CRUD | `packages/guardian/src/admin.ts`, loopback `:3831`, Bearer, deny-all when unset | shipped, **no UI** |
| Portal adapter contract | `docs/portals/community-portals.md` | documented |

**Hard constraints any design must respect** (`core-principles.md` §Security
invariants): the host CLI/admin is the only Compose orchestrator and the Docker
socket never enters a container; all portal traffic enters through Guardian; the
assistant has no Docker socket, no admin credential, and no network path to the
admin process; everything binds to loopback by default; all control-plane logic
lives in `@openpalm/lib`.

---

## 3. Overlap and complementarity

| Concern | Paperclip | OpenPalm |
|---|---|---|
| Company / org chart / reporting lines | **core** | none |
| Multiple human users, boards, shared access | **core** (roadmap ✅) | none — one shared UI password |
| Issue graph, checkout locks, liveness contract | **core** (`doc/execution-semantics.md`) | none |
| Heartbeat scheduling + recovery/watchdogs | **core** | cron only (`knowledge/tasks/`) |
| Per-agent budgets, hard stops, cost ledger | **core** | none |
| Approvals / review gates / action requests | **core** | OpenCode permission asks relayed by Guardian |
| MCP access governance (catalog, policy, audit) | **core** | Guardian serves one tool; OpenCode consumes MCP by config |
| Sandboxed & remote execution providers | **core** (e2b, Modal, Daytona, Cloudflare, k8s) | one container |
| Execution workspaces (git worktrees, sync-back) | **core** (`packages/adapters/AUTHORING.md`) | `workspace/ → /work` bind mount |
| **Persistent memory / knowledge** | **Planned** | **AKM — shipped** |
| **Chat UX, Discord, Slack, voice** | **explicitly out of scope** | **shipped** |
| **Desktop app** | **Planned** | **shipped** (Electron) |
| **Fail-closed ingress moderation** | trust presets only | **shipped, default-on** |
| Provider credential management + OAuth wizard | partial | **shipped** (`/api/setup/*`) |
| Deployment unit | Node process + Postgres | Docker Compose stack |

Read the bold rows in each direction: there is almost no wasted overlap. The two
products are close to orthogonal along the axis that matters — Paperclip
governs *work*, OpenPalm runs *an agent and talks to humans*.

---

## 4. Integration seams, ranked

### Seam A — OpenPalm as a Paperclip adapter (`openpalm_guardian`)

**Highest leverage. Recommended as the strategic bet.**

The decisive fact: Guardian is a transparent 1:1 **native OpenCode** proxy, and
Paperclip already speaks OpenCode. `packages/adapters/opencode-local/src/server/
execute.ts:576` builds `opencode run --format json [--session <id>] [--model …]`
and spawns it as a child process. OpenPalm exposes that same runtime over HTTP
with Basic principal auth. The protocol knowledge transfers; only the transport
changes.

**Shape of the adapter** — an external npm package,
`@openpalm/paperclip-adapter`, requiring **no Paperclip fork**
(`docs/adapters/external-adapters.md`):

- `execute(ctx)`:
  - resolve/create a session — `POST /oc/session` through Guardian
    (`packages/guardian/src/oc-path.ts:62` classifies this as `session-create`)
  - send the wake prompt to the session's message endpoint
    (`oc-path.ts:80` — `session-scoped`, `moderatedWrite`)
  - stream `/oc/event` into `ctx.onLog` / `ctx.onEvent`
  - return `AdapterExecutionResult` with `usage`, `model`, `costUsd`,
    `billingType`, and `sessionParams`
- **Session continuity is free.** Guardian already persists `session_owners` in
  SQLite precisely so sessions survive a restart
  (`packages/guardian/src/ownership.ts` header comment). Paperclip's
  `sessionParams` round-trip lands on a runtime that already remembers.
- `testEnvironment()`: `GET /guardian/health` plus a principal auth probe.
- `getConfigSchema()`: Guardian base URL, principal id, principal secret,
  optional model override.

**Four gaps to close, each named against the invariant it touches:**

1. **Workspace binding.** `packages/adapters/AUTHORING.md` states the
   no-remote-git contract: "The local execution-workspace cwd is the only
   persistence boundary across runs… Never `git push` from adapter runtime
   code." Paperclip hands the adapter a worktree and expects changes back. The
   assistant's mounts are fixed in `core.compose.yml` and give it only
   `workspace/ → /work`.

   **Recommended answer for v1: don't fight this.** Scope OpenPalm agents to
   non-worktree roles — operations, research, knowledge curation, communications,
   triage — where memory and human channels are the differentiator. Paperclip
   already has `claude_local` and `codex_local` for code work. Trying to make
   OpenPalm a better code-worktree runtime than those is competing where we are
   weakest.

2. **Principal provisioning.** Guardian's principal CRUD is loopback-only on
   `:3831` behind a bearer token, deny-all when unset
   (`packages/guardian/src/admin.ts`), and Guardian serves plain HTTP by design
   ("remote TLS termination belongs in operator infrastructure",
   `core-principles.md` §2). So the supported v1 topology is **Paperclip and
   OpenPalm on the same host**. Document that explicitly; anything else needs
   operator-managed TLS.

3. **Attribution granularity.** Guardian isolates per principal, and
   `x-openpalm-user` is an assertion, not an identity. **One Guardian principal
   per Paperclip agent** is the right mapping — it makes Guardian's ownership
   records, audit log, and (after Phase 1) usage accounting line up 1:1 with
   Paperclip's agents and budgets.

4. **Content validation vs. machine callers — the largest security
   consideration in this document.** `GUARDIAN_CONTENT_VALIDATION` defaults on
   in both package code and shipped Compose, and an escalated message is blocked
   when the moderator fails or returns no valid verdict. Paperclip's generated
   wake prompts are long, tool-heavy, and carry issue text authored by other
   agents — they will escalate, and some will be blocked.

   The fix must be a **per-principal, explicitly-granted, audited trusted
   class** — never a global off switch, and never a silent default. Note the
   tension honestly: relaxing moderation for a machine principal is exactly the
   path a prompt-injection payload would want, and Paperclip's own
   `doc/LOW-TRUST-PRESETS.md` disables direct-parent report comments for
   precisely this reason. Any implementation should keep the deterministic
   screen even where it drops the LLM escalation, and log every bypass.

**Effort:** 2–4 weeks for a working non-worktree adapter, assuming Phase 1
enablers exist.

### Seam B — MCP in both directions

**Cheapest. Do this first — it proves the whole thesis with zero code.**

**Paperclip → OpenPalm.** OpenCode is an MCP client, and
`packages/skeleton/system/assistant/opencode.jsonc:26` already ships the
commented `mcp` block for exactly this. Pointing the assistant at Paperclip's
MCP server gives an operator a **conversational front end over their Paperclip
company — from Discord, Slack, or voice.** "What's blocked?" "Approve the
deploy." "Who's over budget?" This is the single highest-value-per-hour item in
this document, and it is the surface Paperclip has explicitly declined to build.

**OpenPalm → Paperclip.** Register Guardian's MCP endpoint
(`packages/guardian/src/mcp.ts`) as a Paperclip `remote_http` connection. Every
Paperclip agent can then call `ask_assistant` — reaching an OpenCode runtime
with AKM memory — behind Paperclip's catalog risk classification, profiles,
policies, and Call Event audit. OpenPalm becomes "the org's memory," available
to every agent, governed by Paperclip.

Guardian's MCP server currently exposes **one** tool. Broadening it (e.g. an
AKM knowledge-search tool) is a natural, contained follow-up and would make this
seam considerably more valuable.

**Invariant changes: none. Configuration only.**

### Seam C — Guardian's compatible API as a Paperclip model provider

**Free. Use it as the smoke test.**

Guardian already serves an OpenAI/Anthropic-compatible listener on
`127.0.0.1:3821` (`packages/guardian/src/openai-api*.ts`), and Paperclip's
OpenCode adapter accepts arbitrary OpenAI-compatible provider JSON through
`PAPERCLIP_OPENCODE_PROVIDERS`
(`packages/adapters/opencode-local/src/server/runtime-config.ts`). Pointing a
Paperclip agent at it routes that agent's traffic through OpenPalm's moderation,
rate limits, and audit trail with no code in either project.

This is the weakest coupling — OpenPalm is reduced to a filtered model endpoint
and contributes no memory or channels — but it is a ten-minute experiment that
validates connectivity, auth, and streaming before anyone writes an adapter.

---

## 5. What OpenPalm should build — and what it must not

### Build (all four are worth doing even if Paperclip disappears tomorrow)

1. **Principal management in the host UI.** Today principals exist only behind
   Guardian's loopback API; `docs/technical/ui-route-map.md` confirms there is
   no page and no `/api/host/*` family for them. Add list / mint / rotate /
   revoke. Implementation lands in `@openpalm/lib` with a thin
   `/api/host/principals*` route family carrying `requireCapability` — the
   existing `/api/host/addons/[name]/credentials` endpoints are the template,
   and `ensurePortalSecret` in the addon secret lifecycle is the pattern to
   reuse. **This is what turns OpenPalm from a single-consumer assistant into a
   credible multi-consumer runtime**, and it is a prerequisite for Seam A.

2. **Per-principal usage and cost accounting in Guardian.** Guardian sees every
   request, already owns a SQLite database, and already writes
   `data/logs/guardian-audit.log`. Recording tokens and cost per principal and
   session is a contained addition to `state-db.ts` plus the proxy's response
   path. It is also **the one thing an external control plane cannot do for
   you** — Paperclip can only account for what an adapter reports back, so
   Guardian-side truth is strictly better. Unlocks budgets, quotas, and
   chargeback.

3. **A trusted-principal class** (Seam A, gap 4): per-principal, explicit,
   audited, off by default, deterministic screen retained.

4. **An optional workspace Compose overlay** so an external orchestrator can
   hand the assistant a working tree. Pure file-drop into
   `config/stack/custom.compose.yml` or a new profile-gated managed overlay —
   exactly the documented addon model, no core change.

### Do not build

**Paperclip's control plane.** Org charts, the issue graph, checkout locks,
heartbeat recovery, watchdogs, budget ledgers, multi-company isolation, sandbox
providers. `doc/execution-semantics.md` alone encodes stranded-`todo` vs
stranded-`in_progress` recovery, silent-run classification, watchdog mutation
caps, and three-tier escalation — all learned from operating real agent teams.
Reproducing it would take quarters and would contradict OpenPalm's own stated
principle that "tooling is a thin wrapper over existing tech… the goal is for
CLI, admin, setup wizard and other management tools to be additive convenience
tools, not required infrastructure tooling" (`core-principles.md`).

**Multi-user human accounts and RBAC inside OpenPalm.** This is the important
"no." It collides head-on with two stated invariants — the single UI login
password and "isolation is between principals rather than between every end user
behind one portal" — and it is precisely Paperclip's core competency (multiple
human users is a completed roadmap item there). Adding it would mean rewriting
`session-store.ts`, the Guardian ownership model, and the entire secret
boundary, to arrive at a worse version of something adjacent and free.

Let Paperclip be the multi-human layer. OpenPalm stays single-operator by
design and multi-*principal* by capability.

---

## 6. How this serves the business use case

Concretely, an "AI agents at work" deployment built on both:

- **Paperclip** holds the company: goals, org chart, issues, budgets,
  approvals, audit, and the heartbeat that keeps work moving.
- **OpenPalm agents** fill the roles where memory and human contact matter —
  an ops agent that remembers last quarter's incidents, a research agent with a
  curated knowledge stash, a comms agent reachable in the team's Slack.
- **Humans reach the company through OpenPalm's channels.** Paperclip's board UI
  is for supervision; OpenPalm's Discord/Slack/voice surfaces are for the
  ninety-second interaction that would otherwise never happen. This is the
  integration's clearest end-user win and it needs no adapter at all — Seam B
  delivers it.
- **Guardian is the safety layer on the human edge** — content validation, rate
  limits, per-principal isolation — while Paperclip's MCP gateway is the safety
  layer on the tool edge. They compose rather than duplicate.

The differentiated pitch for OpenPalm becomes: *the agent runtime that has a
memory and a phone number.*

---

## 7. Risks and open questions

**Licensing.** OpenPalm is MPL-2.0 (file-level copyleft); Paperclip is MIT. An
adapter package authored in this repo and published to npm should be considered
carefully — publishing it as a **separate, permissively-licensed package** would
remove all friction for Paperclip users. *This is a flag for the maintainer to
resolve, not legal advice; confirm with counsel before publishing.*

**Moderation bypass is the real security surface.** See Seam A gap 4. If only
one item from this document gets careful review, make it this one.

**Release cadence mismatch.** Paperclip tags calendar-versioned canaries
(`canary/v2026.804.0-canary.5`, dated the day before this review) and its
adapter contract is still moving — `adapter-plugin.md` in the repo root is a
working note describing the registry being made mutable mid-flight. An external
adapter must pin `@paperclipai/adapter-utils` and expect churn.

**Telemetry.** Paperclip enables anonymous usage telemetry by default
(disable via `PAPERCLIP_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`). OpenPalm
ships none. Any bundled recommendation should call this out for privacy-focused
operators — it is a values mismatch with OpenPalm's "private, self-hosted"
positioning, even if a minor one.

**Topology constraint.** Guardian serves plain HTTP and its admin listener is
loopback-only. Same-host co-deployment is the supported v1; anything else is an
operator TLS problem.

**Open questions for the maintainer:**

1. Is "OpenPalm as an employee runtime under someone else's control plane" the
   positioning you want, or does it cede too much? The alternative — OpenPalm
   grows its own org layer — is analysed above and not recommended, but it is a
   product call, not a technical one.
2. Should Guardian's MCP server grow beyond `ask_assistant` (e.g. AKM knowledge
   search)? That single change would make Seam B substantially more valuable in
   both directions.
3. Is per-principal usage accounting worth doing on its own merits, ahead of any
   Paperclip work? The argument in §5.2 says yes.

---

## 8. Sources

**OpenPalm** (`155c235`): `docs/technical/core-principles.md`,
`docs/technical/design-intent.md`, `docs/how-it-works.md`,
`docs/technical/ui-route-map.md`, `docs/technical/api-spec.md`,
`AGENTS.md`, `docs/portals/community-portals.md`,
`packages/guardian/src/{ownership,state-db,admin,mcp,oc-path,openai-api}.ts`,
`packages/lib/src/control-plane/{addon-ids,task-files,access-toggles}.ts`,
`packages/skeleton/system/assistant/opencode.jsonc`,
`packages/ui/src/lib/server/session-store.ts`.

**Paperclip** (`2ab797d`): `README.md`, `ROADMAP.md`, `doc/PRODUCT.md`,
`doc/execution-semantics.md`, `doc/MCP-ACCESS-GOVERNANCE.md`,
`doc/DEPLOYMENT-MODES.md`, `doc/memory-landscape.md`, `doc/LOW-TRUST-PRESETS.md`,
`packages/adapter-utils/src/{types.ts,ssh.ts,execution-target.ts}`,
`packages/adapters/{AUTHORING.md,opencode-local/src/server/{execute,runtime-config}.ts}`,
`packages/mcp-server/src/tools.ts`,
`server/src/adapters/{builtin-adapter-types,plugin-loader,http/execute}.ts`,
`docs/adapters/external-adapters.md`.
