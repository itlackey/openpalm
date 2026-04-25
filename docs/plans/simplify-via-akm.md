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

## Out of scope

- Replacing the **guardian** HMAC boundary (akm has no equivalent).
- Replacing the **assistant** runtime (OpenCode stays).
- Replacing the **scheduler** logic with akm workflows (akm workflows are stateful task chains, not cron — different concept; the scheduler module stays, only its container packaging changes).
- Building a real graph-memory service (the scheduled graph-build is a pragmatic stand-in).
- Channel adapters — they keep their current contract (sign + POST to guardian); no akm, no stash mount.
