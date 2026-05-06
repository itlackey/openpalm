# Simplify OpenPalm by leveraging akm-cli and the stash directory

## Context

OpenPalm today ships a vector **memory** service (`core/memory` + `packages/memory`, sqlite-vec, mem0-style fact extraction), a planned **OpenViking** structured-knowledge addon, a **scheduler** sidecar service, and a **varlock**-backed secret-validation/redaction layer. Several of these predate the maturity of akm-cli.

As of akm-cli **0.7.4** and `akm-opencode` **0.7.3** (verified against the live repos on 2026-05-06), akm covers exactly the memory/knowledge/skills/vault jobs as first-class asset types — `memory`, `knowledge`, `wiki`, `skill`, `command`, `agent`, `script`, `vault`, `workflow`, `lesson` — with hybrid search, opaque refs, frontmatter on memories (shipped in 0.6.0), `akm remember`, `akm import`, `akm curate`, `akm wiki`, `akm vault`, `akm events list|tail`, `akm history`, and the new `akm proposal | reflect | propose | distill` verbs. The opencode plugin (now 20 tools, hooks `session.created` / `chat.message` / `experimental.chat.system.transform` / `tool.execute.before|after` / `experimental.session.compacting` / `shell.env` / `stop` / `session.idle` / `session.compacted` / `session.deleted` / `permission.ask` / `command.execute.before`) auto-harvests memory and supports `AKM_INDEX_ON_SESSION_END`, `AKM_CONTEXT_BUDGET_CHARS`, `AKM_SCOPE_KEYS`, and `AKM_RETROSPECTIVE_NEGATIVE_PATTERN`. OpenPalm already mounts `${OP_HOME}/data/stash` to `/home/opencode/.akm` and already loads `akm-opencode` as the second OpenCode plugin in the assistant and admin containers.

Crucially: **`akm index --enrich` shipped in 0.7.3** and runs metadata enhancement, memory inference, and graph extraction inside one indexing pass. That single feature absorbs most of what previous revisions of this plan proposed as upstream work. The remaining upstream items are tightened to two real proposals (LLM-fallback hook and vault backends) plus two plugin bug fixes.

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
Each trusted container — **guardian**, **assistant** (which now also runs scheduler), **admin** — gets `akm-cli` installed at a pinned version (target **0.7.4 or newer**) in its Dockerfile (`bun add -g akm-cli@^0.7.4` or equivalent). The akm-opencode plugin no longer auto-installs the CLI as of 0.7.x — it expects `akm` on PATH and errors out with install instructions if missing — so an explicit Dockerfile install is required, not optional. Each container gets a bind-mount of an appropriate stash with `AKM_STASH_DIR` set accordingly:

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
| **LLM fact extraction** (`infer: true` extracted atomic facts from raw text). | **Periodic `akm index --enrich` run** (already shipped in akm 0.7.3). One scheduled automation runs `akm index --enrich` on the shared stash; akm handles inference, metadata enrichment, and graph extraction in a single pass — no OpenPalm-side prompt or work queue. | `${OP_HOME}/config/automations/akm-index.yml` (new) — small `assistant`-action automation that shells `akm index --enrich`. Configure cadence via cron expression in the YAML. |
| **Multi-user / multi-agent / multi-run scoping.** | **Direct CLI flags + plugin env config.** akm 0.7.x ships `--user`, `--agent`, `--run`, `--channel` on `akm remember`; `akm search --filter <key>=<value>` and `akm show --scope <key>=<value>` for query-side filtering. The plugin already auto-attaches scope via `AKM_SCOPE_KEYS=user,agent,run,channel`. OpenPalm sets `AKM_SCOPE_KEYS` accordingly and lets the plugin do the work. | Configure `AKM_SCOPE_KEYS` in `core.compose.yml` for assistant; no new code. *(See upstream issue: scope-flag inconsistency on `search`/`show` and the matching plugin bug.)* |
| **Programmatic / REST API** for non-OpenCode callers. | **Not needed.** Channel adapters never called memory directly — they go through guardian → assistant. The (now in-container) scheduler runs enrichment by shelling `akm index --enrich` locally. Admin manages memories through the `akm` CLI inside its own container, against the shared stash. Admin → scheduler is filesystem-based (write YAML, scheduler watches), not HTTP. | n/a — removed. |
| **Memory feedback** (`memory-feedback` tool). | **Direct call to `akm feedback memory:<ref>`** — already supported in akm 0.7.x. The plugin's `akm_feedback` tool exposes it; OpenPalm just removes its old `memory-feedback` tool. *(See upstream issue: the akm-opencode plugin still has a stale guard skipping `memory:`/`vault:` refs — that's the only thing blocking it today.)* | `akm-opencode` plugin (already loaded); no OpenPalm-side feedback code. |
| **Memory events stream** (`memory-events` tool). | **Direct call to `akm events list|tail`** — already shipped in akm 0.7.x as a durable `events.jsonl` with `--since`/`--type`/`--ref` and byte-offset cursors. Admin reads it for activity views; the scheduler can subscribe via `akm events tail`. | No OpenPalm-side stream. Admin shells `akm events`. |
| **Automatic session-start retrieval with token budget** (the old `memory-context.ts` plugin). | **`akm-opencode` plugin native behaviour.** The plugin already subscribes to `session.created` and respects `AKM_CONTEXT_BUDGET_CHARS` (verified in 0.7.3). OpenPalm sets the env var and the old plugin is deleted. | `core.compose.yml` env for assistant; remove `packages/assistant-tools/opencode/plugins/memory-context.ts`. No replacement plugin needed. |
| **Entity-relation / graph memory.** | **Periodic `akm index --enrich` run, same as inference.** Graph extraction is part of the enrich pass — same automation, no extra work. | Same `akm-index.yml` automation. |
| **Asset-mutation history / audit trail.** | **Direct call to `akm history --since <ts> --include-proposals`** — already shipped in akm 0.7.x. Admin's history view shells the CLI and renders the JSON envelope. | Admin UI; no OpenPalm-side log. |
| **Agent-proposed changes review** *(new capability)*. | **`akm propose` from the assistant + `akm proposal list|show|diff|accept|reject` for admin.** Shipped in akm 0.7.0. The assistant proposes durable stash changes; admin reviews and accepts/rejects via the file-based admin → scheduler control plane (write a YAML, scheduler shells `akm proposal accept <id>`). | Optional follow-up: surface this in admin UI. |
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
7. **Index automation.** Drop a memory into the stash; trigger `akm-index` via the file-based scheduler control plane (sentinel file). Observe `akm index --enrich` runs and produces atomic facts plus graph entries — work done by akm, not OpenPalm. `akm events tail` from any container shows the corresponding events.
8. **Session-start retrieval.** Start a fresh assistant session and inspect the system prompt transform — curated context appears without any user message yet, capped at `OP_CONTEXT_BUDGET_CHARS`.
9. **Vault.** `akm vault list` from inside assistant or admin shows entries previously in `${OP_HOME}/vault/user/*.env`. `akm_vault load` populates env for a tool call. Guardian's HMAC secrets are stored as an `akm vault` inside `${OP_HOME}/data/guardian-stash` and loaded at guardian startup; assistant and admin cannot list them.
10. **No varlock.** `which varlock` fails inside every container; `~/.cache/openpalm/bin/varlock` is gone; `openpalm install` runs end-to-end without downloading any binary; logs containing values for `*_TOKEN`/`*_SECRET`/`*_KEY`/`*_PASSWORD` are masked by the in-house redactor.
11. **Knowledge / wiki.** `akm wiki create test`, `akm_search --type knowledge` returns hits; old `viking_*` tools are gone (no missing-tool errors in assistant logs).
12. **Lifecycle.** `openpalm update` and `openpalm upgrade` succeed without referencing the deleted memory/scheduler/varlock assets.
13. **Tests.** `bun test` in `packages/lib`, `packages/assistant-tools`, `packages/scheduler`, `packages/cli` passes; deleted suites are gone with their packages.

## Recommended upstream enhancements

After reviewing akm-cli **0.7.4** and akm-opencode **0.7.3** against the previous revision of this plan, **the majority of upstream proposals are already shipped**. What remains is a small focused set: two genuine feature requests, one deferred discussion, and two plugin bug fixes.

### Already shipped — no upstream work needed

These were proposed in earlier revisions of this plan and have since landed. OpenPalm consumes them directly.

| Was proposed | Now lives in |
|---|---|
| Memory inference as part of `akm index` | `akm index --enrich` (0.7.3) |
| Graph-build as part of `akm index` | `akm index --enrich` (0.7.3) |
| `akm events list|tail` | shipped in 0.7.x |
| `akm history` | shipped in 0.7.x (`--include-proposals` flag) |
| `akm feedback` accepting `memory:`/`vault:` refs | shipped in 0.7.x (CLI accepts; plugin still has stale guard — see Bugs §1) |
| Scope flags on `akm remember` | shipped (`--user`, `--agent`, `--run`, `--channel`) |
| Plugin `session.created` retrieval with budget | shipped (`AKM_CONTEXT_BUDGET_CHARS`) |
| Plugin auto-attach scope from session metadata | shipped (`AKM_SCOPE_KEYS=user,agent,run,channel`) |
| Plugin negative-cue feedback | shipped (`AKM_RETROSPECTIVE_NEGATIVE_PATTERN`) |
| Plugin session-end `akm index` | shipped (`AKM_INDEX_ON_SESSION_END`) |

### akm-cli — still proposed

1. **Harness-LLM passthrough hook** *(see plugin §1 below for the matching plugin half).*
   - Today: `akm index --enrich` requires an LLM configured at the akm config layer (`akm.llm`). If the host harness already has provider credentials, akm has no way to borrow them.
   - Proposal: a documented hook — environment variable `AKM_LLM_PROXY_CMD` or config key `akm.llm.proxy` — that akm consults when no native `akm.llm` is configured. akm spawns the shim (stdio JSON in / out) and treats it as the LLM backend.
   - Why CLI, not plugin: the contract has to live in akm so any harness (opencode, claude, anything new) can implement the shim half.

2. **Pluggable secret backends and rotation for `akm vault`** *(future consideration, not confirmed).*
   - Today: vault is `.env`-style files only; no rotation, no remote secret-manager integration. Tracks upstream issue #190.
   - Proposal: a backend interface with built-in adapters (OS keychain, age-encrypted files) plus hooks for external managers (`pass`, 1Password CLI, AWS/GCP Secrets Manager, HashiCorp Vault); `akm vault rotate <key>`; `akm vault backend set <name>`.
   - Status: deferred — flagged for evaluation in a future release.

3. **Bug fix: scope-flag inconsistency across `remember` / `search` / `show`.**
   - Today: `akm remember --user X --agent Y` works, but `akm search --user X` is unrecognised — search expects `--filter user=X` and show expects `--scope user=X`.
   - Proposal: pick one shape (probably accept both), or document the asymmetry prominently. Ground truth confirmed in `src/commands/search.ts` (`parseScopeFilterFlags()`) vs `src/commands/remember.ts` (direct flags).
   - Why this matters: the akm-opencode plugin currently passes `--user`/`--agent` directly to all three verbs via a single `buildScopedArgs()` helper, which means scope filtering on plugin-issued `search` / `show` calls silently fails. Fixing the CLI fixes the plugin without a plugin release.

### Explicitly **not** proposed for `akm-cli`

Documented so they aren't re-proposed:
- **`akm serve` / any HTTP daemon** — akm will not serve HTTP. CLI subprocess or shared stash only.
- **`akm workflow schedule` / cron triggers** — scheduling stays in the host.

### akm-plugins — still proposed

1. **Harness-LLM passthrough shim** *(opencode/ and claude/).*
   - Pairs with the CLI hook above. When the harness has provider credentials and akm has no `akm.llm`, the plugin starts a tiny stdio shim, sets `AKM_LLM_PROXY_CMD=<shim path>`, and forwards prompts from akm through the harness's existing provider connection. Returns akm's JSON-shaped result.
   - Why plugin: only the harness has the user-authenticated provider connection.

2. **Bug fix: stale `feedback` guard skipping `memory:` / `vault:` refs.**
   - Today: `akm-plugins/opencode/index.ts` contains `if (ref.startsWith("memory:") || ref.startsWith("vault:")) continue;` with a comment claiming "memories do not accept feedback." That comment is stale relative to akm 0.7.x — the CLI does accept those refs (verified in the CLI docs).
   - Proposal: remove the guard. Mirror the change in `claude/`.

3. **Bug fix (depends on CLI §3): plugin sends `--user`/`--agent` to `search`/`show`.**
   - The `buildScopedArgs()` helper passes scope as direct flags to all verbs, but `search` expects `--filter <k>=<v>` and `show` expects `--scope <k>=<v>`. Either fix is sufficient: (a) wait for CLI §3 to accept both shapes, or (b) update `buildScopedArgs()` to emit the right shape per verb. Mirror in `claude/`.

4. **Cross-harness parity (meta).**
   - Keep parity between `opencode/` and `claude/` as the two bug fixes and the LLM-passthrough shim land.

## Out of scope

- Replacing the **guardian** HMAC boundary (akm has no equivalent).
- Replacing the **assistant** runtime (OpenCode stays).
- Replacing the **scheduler** logic with akm workflows (akm workflows are stateful task chains, not cron — different concept; the scheduler module stays, only its container packaging changes).
- Building a real graph-memory service inside OpenPalm (the periodic `akm index` run is the canonical path once upstream index-time graph building lands).
- Channel adapters — they keep their current contract (sign + POST to guardian); no akm, no stash mount.
- Log-redaction inside akm — that is a host-app concern (handled in OpenPalm's `logger.ts`), not something akm should own.
- Sharing a stash between guardian and the user-facing services — guardian's stash is intentionally isolated; do not collapse them.
