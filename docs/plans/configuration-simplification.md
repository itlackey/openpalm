# Configuration & management simplification

## Context

This document is the next pass after `simplify-via-akm.md` and its upstream-issue drafts. That plan removes whole services (memory, scheduler container, varlock); this one targets the **operational surface** the user and admin actually touch — environment variables, mount points, vault layout, setup wizard, schema files, lifecycle commands, and the small directory tree under `~/.openpalm/`.

Two parallel audits drove this document:

- **Configuration audit** — mapped every env var, every mount, every config file, every install/upgrade hop. Headline: there are 100+ environment variables in flight, ~17 distinct port/bind-address pairs, 4 separate `.env.schema` files (all varlock-shaped), an `init` helper container that exists only to chown directories, and a `config/guardian/` directory that is empty.
- **Legacy / drift audit** — found the docs that no longer match the code (memory-privacy.md, foundations.md, environment-and-mounts.md, opencode-configuration.md, api-spec.md), the roadmap clutter under `.github/roadmap/0.10.0/`, and a clean blast-radius mapping for what is safe to delete now vs. what waits on the akm migration.

The goal of this pass: **shrink the operator's mental model without changing the security model.** Loopback bindings, HMAC channel boundaries, vault file modes, the admin/assistant/guardian trust split — all stay. What changes is the number of knobs you have to know about to install, upgrade, or extend the stack.

## Today's surface (audit summary)

| Surface | Count | Notes |
|---|---|---|
| Environment variables | **~100+** | 5 identity tokens, 9 port + 8 bind-address pairs, ~33 `OP_CAP_*` capability vars, ~14 raw provider keys, ~13 channel vars per channel, owner metadata, paths, OAuth credentials. |
| Distinct port bindings | 9 services × 2 (port + bind-addr) | Each service that listens on the host has its own `OP_*_PORT` + `OP_*_BIND_ADDRESS` pair. Default everywhere is `127.0.0.1`. |
| Mount points (core compose) | ~21 | Includes single-file mounts (`auth.json`, `apprise.yml`), shared workspace, vault/{stack,user}, logs/opencode, AKM stash, etc. |
| Schema files (`.env.schema`) | 4 | `stack.env.schema`, `guardian.env.schema`, `user.env.schema`, `redact.env.schema` — all written for varlock. |
| Vault directories | 3 | `vault/stack/` (operator), `vault/user/` (user secrets), `vault/redact.env.schema` (varlock). |
| Helper containers | 2 | `init` (chown), `docker-socket-proxy` (admin only). |
| Capability layer | `OP_CAP_*` (33 vars) | Derived from `stack.yml` + raw provider keys. The memory service was the main multi-provider consumer; with it gone, only voice addons need this layer. |

Cross-cutting observations from the audits:

1. **Double-bookkeeping**: provider keys are stored as themselves (`OPENAI_API_KEY`) **and** resolved into `OP_CAP_LLM_API_KEY`/`OP_CAP_EMBEDDINGS_API_KEY`. Memory consumed the resolved form; assistant reads either path; voice consumes capabilities. With memory gone, only voice still needs the capability layer.
2. **Schema files are varlock baggage.** Four `.env.schema` files exist purely to feed `varlock load`/`varlock scan`. Once varlock is gone they have no consumer.
3. **`config/guardian/`** is created at install but contains nothing today. Either populate it (and document why) or delete it.
4. **`OP_SETUP_COMPLETE`** is a sentinel env var. The simpler signal is "does `stack.env` exist?" or a stand-alone `vault/stack/.installed` file.
5. **`OP_OPENCODE_PASSWORD`** is wired through compose but the assistant runs with `OPENCODE_AUTH=false` because it's loopback-only. Currently dead.
6. **`MEMORY_USER_ID`, `SYSTEM_LLM_*`, `EMBEDDING_*`** all disappear with the memory service.
7. **Dual setup orchestrators** (CLI wizard + admin UI) both call `performSetup()` — fine; just confirm the path stays single.
8. **Doc drift** is severe in five technical docs and `README.md`. They still describe the memory service, scheduler service, varlock, and OpenViking as core concepts.

## Debate — perspectives and tensions

The proposals below were stress-tested against four perspectives. Where they disagreed, the resolution is recorded as a compromise rather than a winner.

### Security engineer
- Trust boundaries are non-negotiable: loopback by default, HMAC for channel inbound, separate guardian stash for HMAC secrets, mode-0600 vault files, separate admin / assistant / memory / channel tokens.
- Don't merge admin and assistant tokens — different blast radii (admin can mutate the stack; assistant can talk to the LLM).
- Migrating `vault/user/` into `akm vault` inside the **shared** assistant↔admin stash is acceptable **because** the existing `vault/user/` is already mounted into the assistant container (read-only). Same trust level, fewer files. Operator-only secrets stay in `vault/stack/` regardless.
- `OP_OPENCODE_PASSWORD` is currently dead but should remain wired for the (rare) deployment that exposes assistant beyond loopback. Keep the compose plumbing; drop the wizard prompt.

### SRE / DevOps
- The `OP_CAP_*` family is indirection without payoff once memory is gone. Voice keeps a small `TTS_*` / `STT_*` subset; everything else reads provider keys directly.
- 17 port/bind-address pairs is excessive when ~99% of installs use loopback. One `OP_BIND_ADDRESS=127.0.0.1` global default plus per-service port numbers (left as compose defaults) is enough; document a single override for LAN exposure.
- The `init` container exists to chown a handful of directories. With fewer services to seed, replace with a `bash` block in the lifecycle command (or a tiny tini-style entrypoint in the assistant container that fixes its own paths).
- Schema files are dead with varlock — delete them.

### Product / UX
- Wizard asks too many questions. With OpenCode handling OAuth provider auth (Anthropic, Google, GitHub Models) natively, the only manual entries are raw API-key providers (OpenAI, Groq, etc.) and per-channel credentials.
- `OWNER_NAME`/`OWNER_EMAIL` are wizard outputs but no service reads them at runtime — they're metadata for the admin UI display. Move to `akm vault` under `vault:owner` or to the user's stash profile; drop the env vars.
- Drop `OP_SETUP_COMPLETE` — presence of `stack.env` already gates everything.
- `data/setup-token.txt` is wizard-session-only; keep it in process memory and a temp file under `${XDG_RUNTIME_DIR}` instead of a stash-resident file.

### Maintainer
- Fewer files written at install = less drift risk. Each new file is a forever-maintenance commitment.
- Stop maintaining double paths for provider credentials. One canonical name per provider, consumed directly.
- Doc drift will recur unless docs are short and reference the live compose / schema as the source of truth. Cap each technical doc at a single page.
- The `.github/roadmap/0.10.0/` directory has a half-dozen items already obsolete; mark them superseded in one batch rather than letting them rot.

### Tensions and how they resolved
| Tension | Resolution |
|---|---|
| SRE wants to drop `OP_CAP_*`; voice still needs capability resolution. | Keep a tiny `TTS_*` / `STT_*` subset (named directly), drop `OP_CAP_LLM_*` / `OP_CAP_EMBEDDINGS_*` / `OP_CAP_RERANKING_*` / `OP_CAP_SLM_*` entirely. |
| UX wants fewer setup questions; SE notes initial provider choice is hard to defer. | Defer to OpenCode's native auth for OAuth providers; keep one prompt for raw API-key providers. |
| User vault → akm vault concentrates secrets in the shared stash. | Acceptable because the existing `vault/user/` is *already* mounted into the assistant. The trust boundary doesn't change. |
| Dropping `OP_SETUP_COMPLETE` means lifecycle code can't ask "is install done?". | Substitute "does `stack.env` exist with the system-token block populated?" — a stronger signal anyway. |

## Recommendations

Each item is sized for an independent change. Numbered for implementation tracking; not all need to land together. Items align with `simplify-via-akm.md` — items already covered there are linked, not repeated.

### Environment variables — drop or collapse

1. **Delete the `OP_CAP_*` family** (~33 vars). Memory was the main consumer; it's going away. Voice keeps a focused `TTS_PROVIDER` / `TTS_MODEL` / `TTS_API_KEY` / `STT_PROVIDER` / `STT_MODEL` / `STT_API_KEY` subset, named directly. Assistant and admin read provider keys natively (OpenCode handles provider routing).
2. **Delete `SYSTEM_LLM_*`, `EMBEDDING_*`, `MEMORY_USER_ID`, `MEMORY_DATA_DIR`, `MEMORY_CONFIG_PATH`, `MEM0_DIR`, `MEMORY_API_URL`, `MEMORY_AUTH_TOKEN`, `OP_MEMORY_TOKEN`, `OP_MEMORY_PORT`, `OP_MEMORY_BIND_ADDRESS`** — all gone with the memory service. (Already implied by `simplify-via-akm.md`; documented here for completeness.)
3. **Delete varlock vars** — `OP_VARLOCK_*`, plus the `redact.env.schema`. (Already in `simplify-via-akm.md`.)
4. **Collapse port + bind-address pairs.** One global `OP_BIND_ADDRESS=127.0.0.1` (advanced override). Per-service port numbers stay as compose defaults that operators rarely touch; the few services that *are* user-touchable on the host (admin) keep their explicit `OP_ADMIN_PORT`. This drops ~12 env vars.
5. **Drop `OP_SETUP_COMPLETE`.** Presence of populated `vault/stack/stack.env` (or a sibling `.installed` sentinel) is the marker.
6. **Drop the wizard prompt for `OP_OPENCODE_PASSWORD`.** Keep the compose plumbing for the rare LAN-exposed assistant case but make it operator-edits-stack.env-directly, not a setup question.
7. **Move `OWNER_NAME` / `OWNER_EMAIL` out of env into `akm vault`** under a `vault:owner` entry. Admin UI reads via `akm vault show owner` — same trust as today (admin can read its own vault).
8. **`data/setup-token.txt` becomes ephemeral.** Generated in-process during the wizard; written to `${XDG_RUNTIME_DIR}` (cleared on reboot) instead of the stash. No more stale tokens after install.

Net env reduction estimate: **~60–70 vars dropped from the average install**, leaving ~30 actively meaningful ones (provider keys, image tag, admin port + bind, owner-supplied channel creds, OAuth paths).

### Mount points — tighten

9. **Drop the `init` container.** Replace with a small `entrypoint.sh` in the assistant container (it already runs as `OP_UID:OP_GID`); on first boot it `mkdir -p` the few dirs left and chowns them. Fewer compose lines, one fewer image to manage.
10. **Drop `${OP_HOME}/data/memory`** mount (memory service gone).
11. **Drop the scheduler service mounts** (folded into assistant per `simplify-via-akm.md`).
12. **Drop `${OP_HOME}/config/memory/memory.conf.json`** mount (memory config gone).
13. **Drop `${OP_HOME}/config/guardian/`** (currently empty). If guardian ever needs config, prefer reading it from its own stash (`${OP_HOME}/data/guardian-stash`) rather than recreating a config dir.
14. **Single-file mounts.** Keep `auth.json` and `apprise.yml` as single-file binds — they're correct as-is; documented here so we don't accidentally collapse them into the dir mount.

### Vault layout — collapse

15. **Migrate `vault/user/` into `akm vault`** inside the shared assistant↔admin stash. (Already in `simplify-via-akm.md` §6.) This pass adds: drop the `vault/user/` host directory entirely after migration; drop the `user.env.schema` file with varlock.
16. **Delete the four `.env.schema` files** (`stack.env.schema`, `guardian.env.schema`, `user.env.schema`, `redact.env.schema`). Replace runtime validation with a small in-house env-format check (already in `simplify-via-akm.md` for `validate.ts`).
17. **Keep `vault/stack/` as-is**: HMAC channel secrets, admin / assistant tokens, OAuth `auth.json`. Operator-only.

### Setup wizard — fewer questions

18. **Defer OAuth providers to OpenCode.** OpenCode already handles Anthropic, Google, GitHub Models. The wizard prompts only for raw API-key providers (OpenAI-compatible endpoints, Groq, Mistral, etc.) — single page, one provider chosen at install.
19. **Drop the capability prompts.** With `OP_CAP_*` gone, the wizard no longer asks "which provider for embeddings vs. LLM vs. SLM vs. reranking" — the assistant's OpenCode config covers it.
20. **Channel addons stay as-is.** Per-channel credentials are unavoidable.
21. **Owner-info page** stays (one page) but writes to the akm vault profile, not env.

### Lifecycle — simplify

22. **`openpalm install` becomes**: write `vault/stack/stack.env` (system tokens + provider keys), generate `vault/stack/guardian.env` (HMAC secrets), seed the akm stash (skills, commands, agents, owner profile, user vault), `docker compose up -d`. The bullet count in lifecycle.ts shrinks accordingly.
23. **`openpalm update`** stays as it is (compose reconcile, no image pull).
24. **`openpalm upgrade`** stays as it is (image pull + recreate). The `~/.cache/openpalm/rollback/` snapshot continues; `${OP_HOME}/backups/` is verified-and-removed if nothing writes to it.
25. **The `OP_DOCKER_SOCK` override** stays (some hosts need it) but defaults to `/var/run/docker.sock` and stops being a wizard question.

### Documentation — rewrite the five drift sources

26. **Delete `docs/technical/memory-privacy.md`** — service is gone.
27. **Rewrite `docs/technical/foundations.md`** — drop memory / scheduler / varlock sections; document the new admin↔assistant↔guardian topology with akm and shared stash.
28. **Rewrite `docs/technical/environment-and-mounts.md`** — single tables for the surviving env vars and mounts.
29. **Rewrite `docs/technical/api-spec.md`** — drop scheduler HTTP endpoints, drop varlock validate; add the file-based admin → scheduler control plane.
30. **Edit `docs/technical/opencode-configuration.md`** — drop the memory env table.
31. **Edit `docs/technical/core-principles.md`** — drop "varlock as foundational tech".
32. **Edit `README.md`** — drop the varlock sentence; mention akm.
33. **Edit `AGENTS.md`** — collapse the memory/scheduler entries.
34. **Mark superseded** under `.github/roadmap/0.10.0/`: `openviking-integration.md`, `knowledge-system-roadmap.md`, varlock-related items in `cleanup/` and `plans/`.

## What stays — explicit non-changes

These are security- or capability-load-bearing and should **not** be touched in this pass:

- HMAC channel-inbound flow (guardian validates `X-Signature`).
- Loopback bindings as the default for every host port.
- `vault/stack/` as operator-owned with mode-0600 files.
- Separate admin / assistant / guardian / channel-HMAC tokens (different trust scopes).
- Single-file mounts of `auth.json` and `apprise.yml` (correct as-is).
- The admin's `${OP_HOME} → /openpalm rw` mount (it manages the stack — by design).
- The docker-socket-proxy in front of the admin's Docker access.
- `OP_UID` / `OP_GID` set at install (file ownership correctness).

## Phased implementation order

The phases line up so each leaves the stack bootable:

| Phase | Change | Depends on |
|---|---|---|
| **A. Doc rewrite** (#26–#34) | Bring docs into alignment with the post-akm reality. Pure prose; no code risk. | Nothing. |
| **B. Schema-file deletion** (#16) | Delete the four `.env.schema` files and the redactor schema generator. | varlock removal in `simplify-via-akm.md`. |
| **C. Capability-layer removal** (#1, #19) | Drop `OP_CAP_*` env vars; rewire voice addon to use direct names; drop wizard pages. | memory removal in `simplify-via-akm.md`. |
| **D. Vault collapse** (#15) | Migrate `vault/user/` → akm vault; delete the host directory. | akm vault adoption in `simplify-via-akm.md`. |
| **E. Owner-info migration** (#7) | Move owner name/email out of env into akm vault. | Phase D. |
| **F. Port-pair collapse** (#4) | Drop the per-service `*_BIND_ADDRESS` vars; introduce `OP_BIND_ADDRESS` global. | Phase A (so docs match). |
| **G. Init-container removal** (#9) | Replace with entrypoint chown. | Memory & scheduler service deletion. |
| **H. Sentinel cleanup** (#5, #6, #8) | Drop `OP_SETUP_COMPLETE`, deprecate the wizard's password prompt, move the setup token to runtime. | Phase A. |

Phases A–C are independent and can land first; D–E need akm vault wired; F–H are polish.

## Verification

End-to-end checks per phase:

- **A (docs)**: Spot-check each rewritten doc against the live compose + schema. No grep hit for `core/memory`, `MEMORY_API_URL`, `varlock`, `OpenViking`, `core/scheduler` in `docs/`, `README.md`, `AGENTS.md`.
- **B (schemas)**: `find .openpalm -name '*.env.schema'` returns nothing. `openpalm install` succeeds. `openpalm validate` is either gone or runs an akm-vault check without invoking varlock.
- **C (capabilities)**: `grep -r OP_CAP_ packages/` returns no consumers. Voice addon round-trip works using `TTS_*` / `STT_*` only. Memory tests gone.
- **D (vault)**: `vault/user/` directory absent; `akm vault list` shows the migrated entries; assistant `akm_vault load` populates env for a tool call.
- **E (owner)**: `akm vault show owner` returns name/email; admin UI reads it; no `OWNER_*` env in any service.
- **F (ports)**: `OP_BIND_ADDRESS=192.168.1.10 openpalm update` flips every host-bound port to that address; default keeps loopback. `OP_ADMIN_PORT` still overridable per-service.
- **G (init)**: `docker compose ps` shows no `init` container. Fresh install on a clean directory still creates and chowns `data/`, `logs/`, `data/stash/`, `data/guardian-stash/`.
- **H (sentinels)**: First-boot detection works without `OP_SETUP_COMPLETE`. `${OP_HOME}/data/setup-token.txt` does not exist after a successful install.

Cross-cutting:

- `bun test` in `packages/lib`, `packages/cli`, `packages/admin`, `packages/scheduler` passes after each phase.
- Channel HMAC inbound still rejects spoofed messages (negative test).
- `docker compose -f .openpalm/stack/core.compose.yml config` lints clean throughout.

## Out of scope

- Replacing OpenCode's auth model (`auth.json` mount stays).
- Replacing the docker-socket-proxy.
- Changing the trust boundaries between admin / assistant / guardian / channel.
- Multi-host deployments (this stack is LAN-first by design; keep it that way).
- Anything that requires upstream akm changes beyond what `docs/plans/upstream-issues/` already lists.
