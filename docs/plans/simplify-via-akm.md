# Simplify OpenPalm by leveraging akm-cli and the stash directory

## Context

OpenPalm today ships a vector **memory** service (`core/memory` + `packages/memory`, sqlite-vec, mem0-style fact extraction), a planned **OpenViking** structured-knowledge addon, a **scheduler** sidecar service, and a **varlock**-backed secret-validation/redaction layer. Several of these predate the maturity of akm-cli.

As of akm 0.5.0 / 0.6.0-rc1 and `akm-opencode` 0.5.x, akm covers exactly the memory/knowledge/skills/vault jobs as first-class asset types — `memory`, `knowledge`, `wiki`, `skill`, `command`, `agent`, `script`, `vault`, `workflow` — with hybrid search, opaque refs, frontmatter on memories, `akm remember`, `akm import`, `akm curate`, `akm wiki`, `akm vault`, and an opencode plugin that auto-harvests memory on `tool.execute.after` / `stop` / `session.idle`. OpenPalm already mounts `${OP_HOME}/data/stash` to `/home/opencode/.akm` and already loads `akm-opencode` as the second OpenCode plugin in the assistant and admin containers.

The goal is to collapse the stack onto **akm + the shared stash + the assistant container** so OpenPalm carries less code and fewer moving parts:

1. **Delete the memory service.** Replace it with akm memory in the shared stash.
2. **Cancel OpenViking.** Replace it with akm wikis + knowledge.
3. **Delete varlock.** Replace it with `akm vault` for user secrets and a small in-house redactor for stack secrets.
4. **Fold the scheduler into the assistant container.** Run it as a co-process; no separate image, no separate service.
5. **Install the `akm` CLI in every trusted container** (guardian, assistant, admin) and **bind-mount the stash from the host** so the three share state through the filesystem — no Unix sockets, no `akm serve`, no native-deps fragility on macOS (Linux-only inside containers).

Remaining capability gaps (LLM fact inference, multi-user scoping, feedback events, session-start retrieval, graph memory) are filled with **scheduled OpenPalm automations** and **assistant OpenCode plugin tools** rather than upstream akm changes.

## Direct changes

### 1. Delete services and dependencies
- **Memory service.** Remove the `memory` service from `.openpalm/stack/core.compose.yml`. Delete `core/memory/` and `packages/memory/`.
- **OpenViking.** Mark `.github/roadmap/0.10.0/openviking*` and `.github/roadmap/0.10.0/knowledge-system-roadmap.md` as superseded; remove any registry/addon scaffolding for it. Knowledge browsing is now `akm wiki` + `akm search --type knowledge`.
- **Varlock.** Delete `packages/cli/src/lib/varlock.ts`, `packages/lib/src/control-plane/redact-schema.ts`, varlock-specific paths in `packages/lib/src/control-plane/secret-backend.ts` and `packages/lib/src/control-plane/validate.ts`, and the `cli` commands `validate` / `scan` (or rewrite them as no-ops / akm-vault-aware checks). Remove `.openpalm/vault/redact.env.schema`, the `VARLOCK_VERSION` constants, and the binary download/cache logic in `packages/cli/src/commands/install.ts`. Remove tests under `packages/lib/src/control-plane/env-schema-validation.test.ts` and `secret-backend.test.ts` for the deleted paths.

### 2. Fold the scheduler into the assistant container
- Delete `core/scheduler/Dockerfile` and the `scheduler` service block from `.openpalm/stack/core.compose.yml`.
- Add a tiny supervisor entrypoint to the assistant container (e.g., `core/assistant/entrypoint.sh` that uses `dumb-init` or a Bun supervisor script) that starts:
  1. The OpenCode runtime on `:4096`.
  2. `bun packages/scheduler/src/server.ts` on `:8090`, bound only to the assistant container's loopback.
- Both processes share `${OP_HOME}/config`, `${OP_HOME}/data`, `${OP_HOME}/logs`, and the stash mount — already mounted into the assistant container today.
- Admin currently calls `http://scheduler:8090`; rewire to `http://assistant:8090`. Update env/var defaults in `packages/admin/`. The assistant container exposes both `4096` and `8090` on `assistant_net`.
- Keep `packages/scheduler/` (the package) — only the *service container* and Dockerfile go away. The package is consumed by the supervised subprocess.

### 3. Install `akm` in the trusted containers and share the stash from the host
Each trusted container — **guardian**, **assistant** (which now also runs scheduler), **admin** — gets:
- `akm-cli` installed at a pinned version in its Dockerfile (`bun add -g akm-cli@<pin>` or equivalent).
- A bind-mount of `${OP_HOME}/data/stash` to a consistent in-container path with `AKM_STASH_DIR` set accordingly:

| Container | Stash path | Mode |
|---|---|---|
| assistant (and embedded scheduler) | `/home/opencode/.akm` | `rw` (already exists) |
| admin | `/akm` | `rw` (new) |
| guardian | `/akm` | `ro` (new — guardian only reads policy/vault) |

`${OP_HOME}/data/stash` is the **single source of truth** on the host. All three containers read it; assistant and admin write it; guardian is read-only.

### 4. Drop overlapping assistant plugin tools
- Remove `memory-*` and `viking-*` tool registrations from `packages/assistant-tools/src/index.ts`.
- Remove `packages/assistant-tools/opencode/plugins/memory-context.ts` (replaced by `akm-opencode`'s `chat.message` curate-on-message + a slim `session-start-context.ts` plugin — see Gap §6 below).
- Update `core/assistant/opencode/system.md` to point at `akm_search`, `akm_show`, `akm_remember`, `akm_curate`, `akm_feedback`, `akm_wiki`, `akm_vault`, `akm_workflow`.

### 5. Migrate seeded assets into the stash
- Move OpenPalm's bundled skills / commands / agents from `core/assistant/opencode/{commands,agents,skills}/` into stash subdirectories with `.stash.json` metadata.
- Update `packages/lib/src/control-plane/setup.ts` to seed those into `${OP_HOME}/data/stash/` on first install (idempotent — does not overwrite user edits, matching the existing config-ownership rule).

### 6. Move user secrets into `akm vault`; keep stack secrets in plain env files
- During install, write existing `${OP_HOME}/vault/user/*.env` entries via `akm vault create/set` into a stash-resident vault.
- Channel HMAC secrets and admin tokens stay in `${OP_HOME}/vault/stack/*.env` (operator-owned, never visible to assistant). Without varlock, redaction in logs is handled by a small in-house allowlist of secret-named env-var prefixes (`*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`) applied in `packages/lib/src/control-plane/logger.ts`.
- Replace the `load_vault` tool with calls to `akm_vault load`.
- Stop seeding mem0 config: delete `packages/lib/src/control-plane/memory-config.ts` and its callers; remove `MEMORY_API_URL`, `MEMORY_AUTH_TOKEN`, mem0/embedder vars from `vault/stack/stack.env` template, the assistant container env, channel-adapter env, and admin env.

## Gap → resolution map

Every capability the deleted memory/scheduler/varlock layers offered is mapped to an OpenPalm-side resolution. Nothing here requires upstream akm changes.

| Gap | Resolution | Where it lives |
|---|---|---|
| **LLM fact extraction** (`infer: true` extracted atomic facts from raw text). | **Scheduled enrichment automation.** `akm-opencode` writes raw memories with frontmatter `enriched: false`. A new automation runs every N minutes: scheduler invokes the assistant with a deterministic prompt → assistant reads `memories/` entries where `enriched: false`, asks its provider LLM to extract atomic facts, calls `akm remember` per fact with `enriched: true`, deletes the raw entries. | `${OP_HOME}/config/automations/memory-enrich.yml` (new) — `assistant`-action automation. Prompt + tool policy bundled as a stash `agent:memory-enricher`. |
| **Multi-user / multi-agent / multi-run scoping.** | **Frontmatter-based scoping** written by an OpenCode plugin. Plugin attaches `user`, `agent`, `run`, `channel` to every `akm_remember` call as YAML frontmatter; search filters via `akm search --type memory --filter user=…`. | New `packages/assistant-tools/opencode/plugins/memory-scope.ts`. |
| **Programmatic / REST API** for non-OpenCode callers. | **Not needed.** Channel adapters never called memory directly — they go through guardian → assistant. The (now in-container) scheduler runs enrichment by calling the assistant locally. Admin manages memories through the `akm` CLI inside its own container. | n/a — removed. |
| **Memory feedback** (`memory-feedback` tool). | **Plugin tool** that writes a feedback record to the memory's frontmatter (`feedback: [{positive, note, ts}]`); akm hybrid ranking already reads frontmatter for boosting. | New `memory_feedback` tool in `packages/assistant-tools/src/index.ts`. |
| **Memory events stream** (`memory-events` tool). | **Append-only events log file in the stash** (`events/memory.jsonl`). Same plugin appends an event line on every `akm_remember`/`memory_feedback`. Used as the work queue for the enrichment automation. | Stash convention; helpers in `packages/assistant-tools/src/lib/`. |
| **Automatic session-start retrieval with token budget** (the old `memory-context.ts` plugin). | **Slim plugin** subscribed to `session.created` that runs `akm curate --limit N --for-agent` against the current session's scope and injects results via `experimental.chat.system.transform`. Budget controlled by `OP_CONTEXT_BUDGET_CHARS`. | New `packages/assistant-tools/opencode/plugins/session-start-context.ts` (replaces deleted `memory-context.ts`). |
| **Entity-relation / graph memory.** | **Scheduled graph-build automation.** Periodic job invokes assistant to walk recent memories and write `memories/.graph/relations.json`; consumed by `session-start-context.ts` for ranking. Not first-class; can be promoted later. | `${OP_HOME}/config/automations/memory-graph.yml`. |
| **Varlock validation/scan/redact.** | **Replaced by:** (a) `akm vault` enforces secret hygiene for user secrets at write time (mode-0600 files, never echoed); (b) a small log-redactor in `packages/lib/src/control-plane/logger.ts` masks values for env keys matching `_TOKEN|_SECRET|_KEY|_PASSWORD`; (c) `validate` and `scan` CLI commands either go away or become thin wrappers around `akm vault list` + a name-pattern check. | `packages/lib/src/control-plane/logger.ts` (new redactor); CLI commands edited or removed. |
| **History / audit trail of mutations** (memory had `history.db`; varlock had schema-driven audits). | akm itself writes a history log when assets change via CLI; combined with the events log above this covers the audit need. Admin UI surfaces it via the `akm` CLI. | Stash convention. |
| **macOS sqlite-vec / varlock binary fragility.** | **Not an issue** — akm runs inside Linux containers on every host. Varlock is gone. | n/a. |
| **History/scheduler triggers from outside** (admin used to POST to `scheduler:8090`). | Same HTTP API, served by the assistant container on port 8090. Admin updates its base URL. | `packages/admin/` env defaults; scheduler subprocess inside assistant container. |

## Files to modify

Delete:
- `core/memory/` (entire directory)
- `core/scheduler/` (Dockerfile only)
- `packages/memory/` (entire directory)
- `packages/cli/src/lib/varlock.ts`
- `packages/lib/src/control-plane/memory-config.ts`
- `packages/lib/src/control-plane/redact-schema.ts`
- `packages/assistant-tools/opencode/plugins/memory-context.ts`
- `.openpalm/vault/redact.env.schema`
- OpenViking roadmap PRDs at `.github/roadmap/0.10.0/openviking*` and `.github/roadmap/0.10.0/knowledge-system-roadmap.md` (mark superseded if not deleted).

Modify:
- `.openpalm/stack/core.compose.yml` — remove `memory` and `scheduler` services; add `/akm` bind-mount + `AKM_STASH_DIR` to guardian (`ro`), admin (`rw`); confirm assistant mount unchanged; expose `:8090` from assistant on `assistant_net`.
- `core/guardian/Dockerfile`, `core/assistant/Dockerfile`, `core/admin/Dockerfile` — install pinned `akm-cli`. Assistant Dockerfile additionally pulls `packages/scheduler/` and adds the supervisor entrypoint.
- `core/assistant/entrypoint.sh` (new) — supervises OpenCode + scheduler subprocess.
- `packages/scheduler/src/server.ts` — accept `127.0.0.1` bind for in-container loopback; otherwise unchanged.
- `packages/admin/` — change scheduler base URL default from `http://scheduler:8090` to `http://assistant:8090`.
- `packages/cli/src/commands/install.ts` — remove varlock download/install path.
- `packages/cli/src/commands/validate.ts`, `packages/cli/src/commands/scan.ts` — rewrite as akm-vault checks or remove.
- `packages/lib/src/control-plane/secret-backend.ts` — drop varlock provider; user secrets path runs through akm vault.
- `packages/lib/src/control-plane/validate.ts` — drop varlock subprocess; minimal env-format check only.
- `packages/lib/src/control-plane/logger.ts` (or new `redactor.ts`) — name-prefix-based secret redactor.
- `packages/lib/src/control-plane/setup.ts` — seed stash with skills/commands/agents on first install; migrate `vault/user/*.env` → `akm vault`.
- `packages/assistant-tools/src/index.ts` — drop `memory-*` and `viking-*` tools; add `memory_feedback`.
- `packages/assistant-tools/opencode/plugins/` — add `session-start-context.ts` and `memory-scope.ts`.
- `core/assistant/opencode/system.md` — rewrite memory/knowledge guidance around `akm_*` tools.
- `${OP_HOME}/config/automations/memory-enrich.yml`, `memory-graph.yml` — new, installed by setup.
- `vault/stack/stack.env` template — drop `MEMORY_API_URL`, `MEMORY_AUTH_TOKEN`, mem0/embedder vars; drop `OP_VARLOCK_*`.
- `docs/technical/foundations.md`, `environment-and-mounts.md`, `opencode-configuration.md`, `api-spec.md`, `core-principles.md` — refresh mount/service tables; remove memory/scheduler/varlock sections; document `akm` presence in trusted containers.

## Existing utilities to reuse (no new code)

- `${OP_HOME}/data/stash` host directory and `AKM_STASH_DIR` env wiring already exist for the assistant — extend the same convention to the other trusted containers.
- `akm-opencode` plugin already loaded in both assistant and admin OpenCode containers — no install change.
- `packages/lib/src/control-plane/` — keep using the same shared library for install/upgrade; only change *what* gets seeded.
- `packages/scheduler/`'s croner-based loop and YAML automation parser — unchanged; only its container packaging changes.
- Scheduler's existing `assistant` action type is the right primitive for both enrichment and graph-build automations — no new action kind needed.

## Verification

End-to-end checks from a clean `openpalm install` on the simplified stack:

1. **Service count.** `docker compose ps` shows two core services (guardian, assistant) plus addons; no `memory`, no `scheduler`.
2. **akm presence.** `docker compose exec guardian akm --version`, `docker compose exec assistant akm --version`, `docker compose exec admin akm --version` all succeed and report the same pinned version.
3. **Shared stash.** `docker compose exec assistant akm remember "verify-shared-stash"` then `docker compose exec admin akm search verify-shared-stash --type memory --format json` returns the same memory. Repeat write from admin, read from assistant.
4. **Guardian RO mount.** `docker compose exec guardian sh -c 'akm remember nope || echo expected-failure'` produces a write error; reads succeed.
5. **Co-located scheduler.** Inside the assistant container, both `:4096` (OpenCode) and `:8090` (scheduler) are listening; admin can reach `http://assistant:8090/health`. If either subprocess dies, the supervisor restarts it.
6. **Channel round-trip.** Send a chat message → guardian → assistant → assistant uses `akm_remember` → memory file appears in `${OP_HOME}/data/stash/memories/` with scope frontmatter set by `memory-scope.ts`.
7. **Enrichment automation.** Drop a raw memory with `enriched: false` into the stash, manually trigger `memory-enrich` via the in-container scheduler API, observe atomic facts written with `enriched: true` and the raw entry removed.
8. **Session-start retrieval.** Start a fresh assistant session and inspect the system prompt transform — curated context appears without any user message yet, capped at `OP_CONTEXT_BUDGET_CHARS`.
9. **Vault.** `akm vault list` from inside assistant/admin shows entries previously in `${OP_HOME}/vault/user/*.env`. `akm_vault load` populates env for a tool call. Guardian's HMAC secrets still come from `vault/stack/guardian.env`.
10. **No varlock.** `which varlock` fails inside every container; `~/.cache/openpalm/bin/varlock` is gone; `openpalm install` runs end-to-end without downloading any binary; logs containing values for `*_TOKEN`/`*_SECRET`/`*_KEY`/`*_PASSWORD` are masked by the in-house redactor.
11. **Knowledge / wiki.** `akm wiki create test`, `akm_search --type knowledge` returns hits; old `viking_*` tools are gone (no missing-tool errors in assistant logs).
12. **Lifecycle.** `openpalm update` and `openpalm upgrade` succeed without referencing the deleted memory/scheduler/varlock assets.
13. **Tests.** `bun test` in `packages/lib`, `packages/assistant-tools`, `packages/scheduler`, `packages/cli` passes; deleted suites are gone with their packages.

## Recommended upstream enhancements

The plan above closes every gap inside OpenPalm. Some of those shims are general-purpose and would benefit any akm user — they belong upstream rather than re-invented in every host. The list below splits them by where they should land: **`akm-cli`** for anything that does not require an agent harness, and **`akm-plugins`** (the `opencode/` and `claude/` subdirs of `itlackey/akm-plugins`) for anything that needs lifecycle hooks, tool registration, or prompt-transform APIs.

Selection criteria:
- **CLI candidates**: useful outside any specific host, runnable as a one-shot subprocess or daemon, no assumption about an agent loop.
- **Plugin candidates**: only meaningful inside an agent harness because they hook into session lifecycle, tool execution, or system-prompt transforms.

### akm-cli (general, no harness required)

1. **`akm remember --infer` — LLM-driven fact extraction.**
   - Today: `akm remember "<text>"` stores the input verbatim. Consumers that want atomic recall (OpenPalm, RAG pipelines, anyone summarising long inputs) build their own extraction loop.
   - Proposal: an `--infer` flag that uses akm's already-configured optional LLM (the same one wired for indexing-time metadata enrichment) to split the input into atomic facts and store one memory per fact, with frontmatter `inferred: true` and a backref to the source.
   - General value: replaces a recurring downstream pattern with one canonical implementation; turns `akm remember` into a credible substitute for mem0-style fact extractors.

2. **First-class memory scoping (`--user`, `--agent`, `--run`, `--channel`).**
   - Today: scoping is achievable only by setting a different `AKM_STASH_DIR` per scope or by writing custom frontmatter via a host wrapper.
   - Proposal: native scope flags on `akm remember`, plus matching `--filter` / `--scope` options on `akm search` and `akm show`. Scopes persist as canonical frontmatter and the search index pre-filters by them.
   - General value: any multi-user / multi-agent / multi-tenant deployment of akm needs this. Today every consumer invents its own scoping convention, which makes stashes non-portable.

3. **`akm feedback` accepting `memory:` and `vault:` refs.**
   - Today: `akm feedback` rejects `memory:` and `vault:` refs (the opencode plugin auto-skips them as a result), so relevance signal on memories has no upstream path.
   - Proposal: allow feedback on every asset type — vault feedback can store an aggregated count without leaking values. Hybrid ranking already reads frontmatter for boosts, so the wiring is small.
   - General value: closes the relevance-learning loop on the asset type users actually re-rank most.

4. **`akm events` — read/tail asset-mutation events.**
   - Today: there is no documented event stream; consumers have to scrape mtimes or build their own log.
   - Proposal: an append-only `events.jsonl` written by the CLI on every add/update/delete/feedback, surfaced via `akm events list [--since ts]` and `akm events tail`.
   - General value: foundational for any background processor (enrichment, sync, replication, audit) running outside the harness — including OpenPalm's enrichment job, but not specific to it.

5. **`akm history` — surface the existing mutation history.**
   - Today: akm writes mutation history internally; there is no first-class command to read it.
   - Proposal: `akm history [--ref <ref>] [--since ts]` returning per-asset and stash-wide history.
   - General value: trivially closes the audit-trail need that any compliance-conscious user has.

6. **`akm serve` — local HTTP daemon over the stash.**
   - Today: every consumer must shell out to `akm`. Per-call startup cost is real for high-frequency consumers (background workers, automations, cron jobs, remote integrations).
   - Proposal: optional `akm serve --bind 127.0.0.1:8765` exposing the verb surface with the same JSON contract as the CLI. Concurrent stash access is already handled at the file/sqlite layer.
   - General value: lets non-shell consumers integrate without spawning processes; enables remote stash access over the LAN. Not required by the in-container OpenPalm model in this plan, but a strict improvement for anyone running akm consumers across machine boundaries.

7. **Pluggable secret backends and rotation for `akm vault`.**
   - Today: vault is `.env`-style files only; no rotation, no remote secret-manager integration. Tracks upstream issue #190.
   - Proposal: a backend interface with built-in adapters for the OS keychain and age-encrypted files, plus hooks for external managers (`pass`, 1Password CLI, AWS/GCP Secrets Manager, HashiCorp Vault). `akm vault rotate <key>` and `akm vault backend set <name>`.
   - General value: makes `akm vault` a credible production secret store rather than a developer-laptop convenience.

8. **`akm graph build|query` — optional entity/relation index.**
   - Today: akm's hybrid search is purely document-level. Graph reasoning across memories is left to consumers.
   - Proposal: opt-in `akm graph build` that uses the configured LLM to extract entities and relations from `memory:` and `knowledge:` assets, writing a queryable graph file under the stash; `akm graph query "<entity> -> ?"` for traversal; results feed back into search ranking.
   - General value: covers the same gap that motivates separate graph-memory services in many stacks, in a form every akm user can opt into.

9. **`akm workflow schedule` — cron-triggered workflows.**
   - Today: workflows are stateful but invoked manually.
   - Proposal: `akm workflow schedule <workflow-ref> "<cron>"` registering a schedule alongside the workflow definition; an `akm scheduler tick` (or daemon mode under `akm serve`) fires due workflows.
   - General value: collapses the common "cron + script" pattern into akm's existing workflow primitive. Useful for any user who wants periodic background tasks without bringing in a separate scheduler.

10. **Single configurable LLM block reused across enrichment verbs.**
    - Today: the optional LLM is wired for indexing-time enrichment but not exposed as the engine for `--infer`, `graph build`, or future inference verbs.
    - Proposal: one `akm.llm` config block, reused by every LLM-needing verb, with explicit per-verb opt-out.
    - General value: one place to configure, consistent behaviour across enrichment, inference, and graph building.

### akm-plugins (harness-coupled — `opencode/` and `claude/` subdirs)

1. **`session.created` retrieval with token budget.**
   - Today: akm-opencode injects context on `chat.message` (curate-on-message), not on session start. Cold sessions miss curated context until the user types.
   - Proposal: subscribe to the harness's session-start hook, run `akm curate --limit N --for-agent` against the session's scope (using the new CLI scope flags above), and inject via the harness's system-prompt transform. Budget configurable via `AKM_CONTEXT_BUDGET_CHARS`.
   - Why plugin, not CLI: requires harness lifecycle hooks and prompt-transform APIs that only exist inside the agent runtime.

2. **Auto-attach scope from harness session metadata.**
   - Proposal: when the harness exposes session metadata (channel, user id, agent id), the plugin transparently passes those through to the new CLI scope flags on every `akm_remember` / `akm_curate` call. No user action required.
   - Why plugin: scope sources are harness-specific (OpenCode session ids, Claude Code thread ids, etc.).

3. **Conversation-derived feedback.**
   - Today: akm-opencode has `AKM_RETROSPECTIVE_FEEDBACK_PATTERN` matching positive cues. Could be extended to negative cues, multi-turn confirmation, and explicit "this was wrong" detection, then call the new `akm feedback memory:…` once the CLI accepts memory refs.
   - Why plugin: needs access to the conversation transcript and the harness's tool-execution timeline.

4. **Session-end consolidation via `akm remember --infer`.**
   - Today: the plugin already flushes a session buffer into a memory artifact on `stop` / `session.idle` / `session.compacted` / `session.deleted`.
   - Proposal: once `--infer` lands upstream, switch the consolidation step to `akm remember --infer` so the result is atomic facts rather than a single blob — without each plugin reinventing extraction.
   - Why plugin: the trigger is the harness lifecycle event.

5. **Per-thread / per-conversation stash overlays.**
   - Proposal: optional plugin mode that points `AKM_STASH_DIR` at a per-thread overlay stash that inherits from the global stash (read-through, write-local) for the duration of a session, then merges back on session end.
   - Why plugin: scope is the harness's thread/session boundary.

6. **Cross-harness parity.**
   - Proposal: keep feature parity between `opencode/` and `claude/` as new hooks land — the same scope-attach, session-start retrieval, and feedback-inference behaviours should ship in both.
   - Why plugin: each harness has its own hook surface; parity has to be coded per-harness.

## Out of scope

- Replacing the **guardian** HMAC boundary (akm has no equivalent).
- Replacing the **assistant** runtime (OpenCode stays).
- Replacing the **scheduler** logic with akm workflows (akm workflows are stateful task chains, not cron — different concept; the scheduler module stays, only its container packaging changes).
- Building a real graph-memory service (the scheduled graph-build is a pragmatic stand-in until the upstream `akm graph` proposal above lands).
- Channel adapters — they keep their current contract (sign + POST to guardian); no akm, no stash mount.
- Log-redaction inside akm — that is a host-app concern (handled in OpenPalm's `logger.ts`), not something akm should own.
