# Simplify OpenPalm by leveraging akm-cli and the stash directory

## Context

OpenPalm today ships a vector **memory** service (`core/memory` + `packages/memory`, sqlite-vec, mem0-style fact extraction), a planned **OpenViking** structured-knowledge addon, a **scheduler** sidecar service, and a **varlock**-backed secret-validation/redaction layer. Several of these predate the maturity of akm-cli.

As of akm 0.5.0 / 0.6.0-rc1 and `akm-opencode` 0.5.x, akm covers exactly the memory/knowledge/skills/vault jobs as first-class asset types — `memory`, `knowledge`, `wiki`, `skill`, `command`, `agent`, `script`, `vault`, `workflow` — with hybrid search, opaque refs, frontmatter on memories, `akm remember`, `akm import`, `akm curate`, `akm wiki`, `akm vault`, and an opencode plugin that auto-harvests memory on `tool.execute.after` / `stop` / `session.idle`. OpenPalm already mounts `${OP_HOME}/data/stash` to `/home/opencode/.akm` and already loads `akm-opencode` as the second OpenCode plugin in the assistant and admin containers.

The goal is to collapse the stack onto **akm + the shared stash + the assistant container** so OpenPalm carries less code and fewer moving parts:

1. **Delete the memory service.** Replace it with akm memory in the shared stash.
2. **Cancel OpenViking.** Replace it with akm wikis + knowledge.
3. **Delete varlock.** Replace it with `akm vault` for user secrets and a small in-house redactor for stack secrets.
4. **Fold the scheduler into the assistant container.** Run it as a co-process; no separate image, no separate service.
5. **Install the `akm` CLI in every trusted container** (guardian, assistant, admin) and **bind-mount stash directories from the host**: assistant and admin share one stash (the user's memory / knowledge / skills); guardian gets its own separate persisted stash for operator-only data. No Unix sockets, no `akm serve`, no native-deps fragility on macOS (Linux-only inside containers).

Remaining capability gaps (LLM fact inference, multi-user scoping, feedback events, session-start retrieval, graph memory) are filled with **scheduled OpenPalm automations** and **assistant OpenCode plugin tools** rather than upstream akm changes.

## Direct changes

### 1. Delete services and dependencies
- **Memory service.** Remove the `memory` service from `.openpalm/stack/core.compose.yml`. Delete `core/memory/` and `packages/memory/`.
- **OpenViking.** Mark `.github/roadmap/0.10.0/openviking*` and `.github/roadmap/0.10.0/knowledge-system-roadmap.md` as superseded; remove any registry/addon scaffolding for it. Knowledge browsing is now `akm wiki` + `akm search --type knowledge`.
- **Varlock.** Delete `packages/cli/src/lib/varlock.ts`, `packages/lib/src/control-plane/redact-schema.ts`, varlock-specific paths in `packages/lib/src/control-plane/secret-backend.ts` and `packages/lib/src/control-plane/validate.ts`, and the `cli` commands `validate` / `scan` (or rewrite them as no-ops / akm-vault-aware checks). Remove `.openpalm/vault/redact.env.schema`, the `VARLOCK_VERSION` constants, and the binary download/cache logic in `packages/cli/src/commands/install.ts`. Remove tests under `packages/lib/src/control-plane/env-schema-validation.test.ts` and `secret-backend.test.ts` for the deleted paths.

### 2. Fold the scheduler into the assistant container; drop its HTTP API
- Delete `core/scheduler/Dockerfile` and the `scheduler` service block from `.openpalm/stack/core.compose.yml`.
- Add a tiny supervisor entrypoint to the assistant container (e.g., `core/assistant/entrypoint.sh` that uses `dumb-init` or a Bun supervisor script) that starts:
  1. The OpenCode runtime on `:4096`.
  2. `bun packages/scheduler/src/server.ts` as a background process **with no exposed port** — the scheduler runs purely as a file-watching automation engine inside the assistant container.
- Both processes share `${OP_HOME}/config`, `${OP_HOME}/data`, `${OP_HOME}/logs`, and the stash mount — already mounted into the assistant container today.
- **Admin no longer talks to the scheduler over HTTP.** Admin already mounts `${OP_HOME}/config` rw and now has direct write access to `${OP_HOME}/config/automations/*.yml`. The scheduler subprocess inside the assistant container watches that directory (already supported via the existing `startWatching` path in `packages/scheduler/src/scheduler.ts`) and picks up adds / edits / removes immediately. No API call, no token, no port mapping.
- **Manual triggers and execution logs become file-based too.** Admin reads execution logs from the shared `${OP_HOME}/logs/` mount it already has. Manual triggers are expressed by writing a small "trigger" sentinel file (e.g., `${OP_HOME}/data/scheduler/triggers/<automation>.run`) that the scheduler watches; the scheduler executes the named automation and removes the sentinel. This keeps the entire admin → scheduler control plane on the filesystem.
- The HTTP server in `packages/scheduler/src/server.ts` becomes a no-op (or is deleted): keep `getSchedulerStatus`, `getLoadedAutomations`, `getExecutionLog`, `triggerAutomation` as plain library calls used by the file-watcher and (optionally) the assistant via an OpenCode tool, but stop binding any port.
- Keep `packages/scheduler/` (the package) — only the *service container*, the Dockerfile, and the HTTP layer go away. The package's croner loop and YAML parser are reused as the supervised subprocess.

### 3. Install `akm` in the trusted containers; share a stash between admin and assistant; give guardian its own
Each trusted container — **guardian**, **assistant** (which now also runs scheduler), **admin** — gets `akm-cli` installed at a pinned version in its Dockerfile (`bun add -g akm-cli@<pin>` or equivalent), plus a bind-mount of an appropriate stash with `AKM_STASH_DIR` set accordingly:

| Container | Host source | In-container path | Mode | Notes |
|---|---|---|---|---|
| assistant (+ scheduler subprocess) | `${OP_HOME}/data/stash` | `/home/opencode/.akm` | `rw` | already exists |
| admin | `${OP_HOME}/data/stash` *(same as assistant)* | `/akm` | `rw` | new — admin and assistant share one stash so admin can browse/edit user memories, knowledge, skills, vaults, etc. |
| guardian | `${OP_HOME}/data/guardian-stash` *(separate)* | `/akm` | `rw` | new — guardian's own persisted stash for operator-only artifacts (e.g., HMAC vault, channel policies). Guardian cannot read or write the user stash. |

Two stashes, two trust scopes:
- **`${OP_HOME}/data/stash`** is the user-facing stash — single source of truth for memory, knowledge, skills, commands, agents, workflows, user vault. Shared rw between assistant and admin.
- **`${OP_HOME}/data/guardian-stash`** is the operator-facing stash for guardian. Holds channel HMAC secrets in `akm vault` form, channel policies, and any guardian-local audit it wants to persist. Not visible to assistant or admin.

This split keeps guardian's blast radius small: a compromised assistant cannot tamper with channel secrets, and a compromised guardian cannot read user memories.

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
| **LLM fact extraction** (`infer: true` extracted atomic facts from raw text). | **Periodic `akm index` run.** Once enrichment is folded into akm's index process upstream (see Recommended upstream enhancements §1), OpenPalm just needs to run `akm index` on a cadence — akm picks up any memories pending inference and processes them according to its global config. No bespoke OpenPalm prompt or work queue. | `${OP_HOME}/config/automations/akm-index.yml` (new) — small `assistant`-action automation that shells `akm index`. Bundled config in the stash enables enrichment. |
| **Multi-user / multi-agent / multi-run scoping.** | **Frontmatter-based scoping** written by an OpenCode plugin. Plugin attaches `user`, `agent`, `run`, `channel` to every `akm_remember` call as YAML frontmatter; search filters via `akm search --type memory --filter user=…`. | New `packages/assistant-tools/opencode/plugins/memory-scope.ts`. |
| **Programmatic / REST API** for non-OpenCode callers. | **Not needed.** Channel adapters never called memory directly — they go through guardian → assistant. The (now in-container) scheduler runs enrichment by shelling `akm index` locally. Admin manages memories through the `akm` CLI inside its own container, against the shared stash. Admin → scheduler is filesystem-based (write YAML, scheduler watches), not HTTP. | n/a — removed. |
| **Memory feedback** (`memory-feedback` tool). | **Direct call to `akm feedback`** once it accepts any valid ref upstream (Recommended upstream enhancements §3). The OpenCode plugin wraps it as `akm_feedback` — no custom frontmatter writing. | `akm-opencode` plugin (already loaded); thin call-site in `packages/assistant-tools`. |
| **Memory events stream** (`memory-events` tool). | **Dropped.** With enrichment running inside `akm index`, OpenPalm no longer needs an event stream as a work queue. No equivalent surface is added. | n/a — removed. |
| **Automatic session-start retrieval with token budget** (the old `memory-context.ts` plugin). | **Slim plugin** subscribed to `session.created` that runs `akm curate --limit N --for-agent` against the current session's scope and injects results via `experimental.chat.system.transform`. Budget controlled by `OP_CONTEXT_BUDGET_CHARS`. | New `packages/assistant-tools/opencode/plugins/session-start-context.ts` (replaces deleted `memory-context.ts`). |
| **Entity-relation / graph memory.** | **Periodic `akm index` run, same as enrichment.** Once graph building is folded into akm's index process upstream (Recommended upstream enhancements §7), the same scheduled `akm index` automation builds and refreshes the graph based on akm config. | Same `akm-index.yml` automation as enrichment. |
| **Varlock validation/scan/redact.** | **Replaced by:** (a) `akm vault` enforces secret hygiene for user secrets at write time (mode-0600 files, never echoed); (b) a small log-redactor in `packages/lib/src/control-plane/logger.ts` masks values for env keys matching `_TOKEN`/`_SECRET`/`_KEY`/`_PASSWORD`; (c) `validate` and `scan` CLI commands either go away or become thin wrappers around `akm vault list` + a name-pattern check. | `packages/lib/src/control-plane/logger.ts` (new redactor); CLI commands edited or removed. |
| **History / audit trail of mutations** (memory had `history.db`; varlock had schema-driven audits). | **Direct call to `akm history`** once it lands upstream (Recommended upstream enhancements §5). Admin's history view shells `akm history --since <ts> --format json` against the shared stash. For real-time observers (e.g., notifications on new memories), `akm events tail` (Recommended upstream enhancements §4) is the natural fit. | Admin UI; no OpenPalm-side log to maintain. |
| **macOS sqlite-vec / varlock binary fragility.** | **Not an issue** — akm runs inside Linux containers on every host. Varlock is gone. | n/a. |
| **Scheduler triggers from outside** (admin used to POST to `scheduler:8090`). | **No HTTP at all.** Admin writes automation YAML to `${OP_HOME}/config/automations/`; scheduler watches the directory and reloads. Manual triggers happen by dropping a sentinel file in `${OP_HOME}/data/scheduler/triggers/`; execution logs are read from `${OP_HOME}/logs/`. Admin's existing rw mounts on `config/`, `data/`, and `logs/` are sufficient. | `packages/admin/` UI/services switch from HTTP client to filesystem ops; scheduler `startWatching` covers reload; small sentinel-file watcher added. |
| **Guardian operator data** (HMAC channel secrets, policies). | **Guardian's own persisted stash** at `${OP_HOME}/data/guardian-stash`. Channel secrets live as an `akm vault` inside that stash, loaded at guardian startup; not readable by assistant or admin. | `${OP_HOME}/data/guardian-stash/` (new host directory); bind-mounted only into guardian. |

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
- `.openpalm/stack/core.compose.yml` — remove `memory` and `scheduler` services; mount `${OP_HOME}/data/stash` (rw) into admin at `/akm` and confirm assistant mount unchanged; mount `${OP_HOME}/data/guardian-stash` (rw) into guardian at `/akm` as a *separate* host directory; set `AKM_STASH_DIR` accordingly in each container. **No port 8090 exposure** — scheduler is purely in-process inside the assistant container.
- `core/guardian/Dockerfile`, `core/assistant/Dockerfile`, `core/admin/Dockerfile` — install pinned `akm-cli`. Assistant Dockerfile additionally pulls `packages/scheduler/` and adds the supervisor entrypoint.
- `core/assistant/entrypoint.sh` (new) — supervises OpenCode + scheduler subprocess.
- `packages/scheduler/src/server.ts` — strip the HTTP layer; keep the croner loop, YAML loader, and the file-watcher; add a sentinel-file watcher under `${OP_HOME}/data/scheduler/triggers/` for manual triggers.
- `packages/admin/` — replace the scheduler HTTP client with filesystem operations: write/edit YAML in `${OP_HOME}/config/automations/`, drop sentinel files for triggers, read logs from `${OP_HOME}/logs/`. Drop the scheduler base URL and admin → scheduler auth token from config.
- `packages/cli/src/commands/install.ts` — remove varlock download/install path.
- `packages/cli/src/commands/validate.ts`, `packages/cli/src/commands/scan.ts` — rewrite as akm-vault checks or remove.
- `packages/lib/src/control-plane/secret-backend.ts` — drop varlock provider; user secrets path runs through akm vault.
- `packages/lib/src/control-plane/validate.ts` — drop varlock subprocess; minimal env-format check only.
- `packages/lib/src/control-plane/logger.ts` (or new `redactor.ts`) — name-prefix-based secret redactor.
- `packages/lib/src/control-plane/setup.ts` — seed stash with skills/commands/agents on first install; migrate `vault/user/*.env` → `akm vault`.
- `packages/assistant-tools/src/index.ts` — drop `memory-*` and `viking-*` tools; add `memory_feedback`.
- `packages/assistant-tools/opencode/plugins/` — add `session-start-context.ts` and `memory-scope.ts`.
- `core/assistant/opencode/system.md` — rewrite memory/knowledge guidance around `akm_*` tools.
- `${OP_HOME}/config/automations/akm-index.yml` — new, installed by setup; runs `akm index` on a cadence so akm's enrichment + graph passes process pending memories.
- `${OP_HOME}/data/guardian-stash/` — new host directory; seeded by setup with guardian's HMAC-secrets vault.
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
3. **Shared admin/assistant stash.** `docker compose exec assistant akm remember "verify-shared-stash"` then `docker compose exec admin akm search verify-shared-stash --type memory --format json` returns the same memory. Repeat write from admin, read from assistant.
4. **Guardian stash isolation.** `docker compose exec guardian akm search verify-shared-stash` returns no results (different stash). `docker compose exec guardian akm vault list` shows guardian's own HMAC entries. `docker compose exec assistant ls -la /home/opencode/.akm` does not include any guardian-only artifact.
5. **Co-located scheduler with no HTTP.** Inside the assistant container, only `:4096` (OpenCode) is listening; the scheduler subprocess is running but binds no port. If either subprocess dies, the supervisor restarts it. From admin, write a new YAML into `${OP_HOME}/config/automations/test.yml` and observe (within a couple of seconds) that the scheduler picks it up — visible in `${OP_HOME}/logs/scheduler.log` and in `getLoadedAutomations()`. Drop a sentinel file in `${OP_HOME}/data/scheduler/triggers/test.run` and observe the automation fires once and the sentinel is removed.
6. **Channel round-trip.** Send a chat message → guardian → assistant → assistant uses `akm_remember` → memory file appears in `${OP_HOME}/data/stash/memories/` with scope frontmatter set by `memory-scope.ts`.
7. **Index automation.** With akm config enabling enrichment, drop a memory with `inferred: false` into the stash, manually trigger `akm-index` via the in-container scheduler API, observe atomic facts written with `inferred: true` (work done by `akm index`, not OpenPalm).
8. **Session-start retrieval.** Start a fresh assistant session and inspect the system prompt transform — curated context appears without any user message yet, capped at `OP_CONTEXT_BUDGET_CHARS`.
9. **Vault.** `akm vault list` from inside assistant or admin shows entries previously in `${OP_HOME}/vault/user/*.env`. `akm_vault load` populates env for a tool call. Guardian's HMAC secrets are stored as an `akm vault` inside `${OP_HOME}/data/guardian-stash` and loaded at guardian startup; assistant and admin cannot list them.
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

1. **Memory-inference as part of `akm index`, controlled by global config.**
   - Today: `akm remember "<text>"` stores the input verbatim. Consumers that want atomic recall (RAG pipelines, anyone summarising long inputs) build their own extraction loop.
   - Proposal: extend the existing index process to detect memories pending inference and run the configured LLM over them, splitting each into atomic memories with frontmatter `inferred: true` and a backref to the source. Toggle via `akm config set index.infer true|false`. When disabled, indexing leaves memories untouched. When enabled, every `akm index` run drains the pending queue.
   - General value: one configuration switch turns `akm` into a credible substitute for mem0-style fact extractors. Folding the work into the existing indexing pipeline keeps the verb surface small (no new `--infer` flag) and lets users take advantage of it just by scheduling `akm index`.

2. **First-class memory scoping (`--user`, `--agent`, `--run`, `--channel`).**
   - Today: scoping is achievable only by setting a different `AKM_STASH_DIR` per scope or by writing custom frontmatter via a host wrapper.
   - Proposal: native scope flags on `akm remember`, plus matching `--filter` / `--scope` options on `akm search` and `akm show`. Scopes persist as canonical frontmatter and the search index pre-filters by them.
   - General value: any multi-user / multi-agent / multi-tenant deployment of akm needs this. Today every consumer invents its own scoping convention, which makes stashes non-portable.

3. **`akm feedback` accepting any valid ref.**
   - Today: `akm feedback` rejects some ref types (notably `memory:` and `vault:`), and the opencode plugin auto-skips those refs as a result, so relevance signal on memories and vaults has no upstream path.
   - Proposal: allow feedback on **any** valid ref. Vault feedback can store an aggregated count without leaking values. Hybrid ranking already reads frontmatter for boosts, so the wiring is small.
   - General value: closes the relevance-learning loop uniformly across asset types instead of asking consumers to remember which refs are "feedback-eligible".

4. **`akm events` — read/tail asset-mutation events.**
   - Today: there is no documented event stream; consumers have to scrape mtimes or build their own log.
   - Proposal: an append-only `events.jsonl` written by the CLI on every add / update / delete / feedback / index pass, surfaced via `akm events list [--since ts]` and `akm events tail`. Same JSON envelope conventions as the rest of the CLI.
   - General value: foundational for any external observer (sync, replication, audit, dashboards) that needs to react to stash changes without polling. Pairs naturally with the periodic-`akm index` pattern for downstream consumers.

5. **`akm history` — surface the existing mutation history.**
   - Today: akm writes mutation history internally; there is no first-class command to read it.
   - Proposal: `akm history [--ref <ref>] [--since ts]` returning per-asset and stash-wide history with the same JSON envelope.
   - General value: closes the audit-trail need without forcing every downstream tool to build its own. Distinct from `akm events`: history is per-asset state changes; events is the realtime stream.

6. **Pluggable secret backends and rotation for `akm vault`** *(future consideration, not confirmed).*
   - Today: vault is `.env`-style files only; no rotation, no remote secret-manager integration. Tracks upstream issue #190.
   - Proposal: a backend interface with built-in adapters for the OS keychain and age-encrypted files, plus hooks for external managers (`pass`, 1Password CLI, AWS/GCP Secrets Manager, HashiCorp Vault). `akm vault rotate <key>` and `akm vault backend set <name>`.
   - General value: makes `akm vault` a credible production secret store rather than a developer-laptop convenience.
   - Status: deferred — flagged for evaluation in a future release; not part of the immediate roadmap.

7. **Graph-build as part of `akm index`, controlled by global config.**
   - Today: akm's hybrid search is purely document-level. Graph reasoning across memories is left to consumers.
   - Proposal: same shape as the inference change — extend the index process to optionally extract entities and relations from `memory:` and `knowledge:` assets and persist a queryable graph file under the stash. Toggle via `akm config set index.graph true|false`. Search ranking consults the graph when it exists.
   - General value: covers the gap that motivates separate graph-memory services in many stacks. Folding it into indexing means users don't manage a separate `graph build` cadence — one `akm index` run keeps everything in sync.

8. **Single configurable LLM block reused across index passes.**
   - Today: the optional LLM is wired for indexing-time metadata enrichment but is not exposed as the engine for the new inference / graph passes above.
   - Proposal: one `akm.llm` config block, reused by every LLM-needing pass inside `akm index`, with explicit per-pass opt-out.
   - General value: one place to configure, consistent behaviour across enrichment, inference, and graph building.

### Explicitly **not** proposed for `akm-cli`

These were considered and rejected (per maintainer direction). Documenting them so they aren't reproposed:
- **`akm serve` / any HTTP daemon** — akm will not serve HTTP. The CLI is the only programmatic surface; consumers either embed it as a subprocess or share the stash directory.
- **`akm workflow schedule` / cron triggers** — out of scope for akm. Scheduling stays in the host (cron, systemd, the host app's scheduler).

### akm-plugins (harness-coupled — `opencode/` and `claude/` subdirs)

1. **`session.created` retrieval with token budget.**
   - Today: akm-opencode injects context on `chat.message` (curate-on-message), not on session start. Cold sessions miss curated context until the user types.
   - Proposal: subscribe to the harness's session-start hook, run `akm curate --limit N --for-agent` against the session's scope (using the new CLI scope flags above), and inject via the harness's system-prompt transform. Budget configurable via `AKM_CONTEXT_BUDGET_CHARS`.
   - Why plugin, not CLI: requires harness lifecycle hooks and prompt-transform APIs that only exist inside the agent runtime.

2. **Auto-attach scope from harness session metadata.**
   - Proposal: when the harness exposes session metadata (channel, user id, agent id), the plugin transparently passes those through to the new CLI scope flags on every `akm_remember` / `akm_curate` call. No user action required.
   - Why plugin: scope sources are harness-specific (OpenCode session ids, Claude Code thread ids, etc.).

3. **Conversation-derived feedback.**
   - Today: akm-opencode has `AKM_RETROSPECTIVE_FEEDBACK_PATTERN` matching positive cues. Could be extended to negative cues, multi-turn confirmation, and explicit "this was wrong" detection, then call `akm feedback <ref>` against any harvested ref once the CLI accepts any valid ref (CLI §3).
   - Why plugin: needs access to the conversation transcript and the harness's tool-execution timeline.

4. **Session-end optional `akm index`.**
   - Today: the plugin already flushes a session buffer into a memory artifact on `stop` / `session.idle` / `session.compacted` / `session.deleted`.
   - Proposal: after the flush, optionally invoke `akm index` (gated by an env toggle, e.g., `AKM_INDEX_ON_SESSION_END=1`). With the new index-pass config (CLI §1, §5), a single `akm index` run handles inference and graph building — no plugin-side extraction logic.
   - Why plugin: the trigger is the harness lifecycle event; the work itself is now upstream.

5. **Harness-provided LLM fallback for akm passes.**
   - Today: if no LLM is configured for akm, the new index passes (inference, graph) cannot run.
   - Proposal: when the harness already has provider credentials configured for the agent, the plugin offers them to akm as the LLM backend for index-time passes. Concretely, the plugin sets a CLI-side env / config (e.g., `AKM_LLM_PROXY_CMD` pointing at a tiny shim the plugin exposes) that akm consults when no native `akm.llm` is configured. The shim forwards prompts through the harness's existing connection.
   - Why plugin: only the harness has the user-authenticated provider connection; akm itself stays harness-agnostic.

6. **Cross-harness parity.**
   - Proposal: keep feature parity between `opencode/` and `claude/` as new hooks land — the same scope-attach, session-start retrieval, feedback-inference, session-end-index, and harness-LLM-fallback behaviours should ship in both.
   - Why plugin: each harness has its own hook surface; parity has to be coded per-harness.

## Out of scope

- Replacing the **guardian** HMAC boundary (akm has no equivalent).
- Replacing the **assistant** runtime (OpenCode stays).
- Replacing the **scheduler** logic with akm workflows (akm workflows are stateful task chains, not cron — different concept; the scheduler module stays, only its container packaging changes).
- Building a real graph-memory service inside OpenPalm (the periodic `akm index` run is the canonical path once upstream index-time graph building lands).
- Channel adapters — they keep their current contract (sign + POST to guardian); no akm, no stash mount.
- Log-redaction inside akm — that is a host-app concern (handled in OpenPalm's `logger.ts`), not something akm should own.
- Sharing a stash between guardian and the user-facing services — guardian's stash is intentionally isolated; do not collapse them.
