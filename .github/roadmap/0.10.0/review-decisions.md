# 0.10.0 Review — Decision Log

Decisions made 2026-03-15 in response to the cross-plan alignment review report.
Updated 2026-03-19: Q2 reversed, Q9 updated, Q3/Q10 annotated, Q11 added (FS refactor).

---

## Q1. OpenViking: Core Service or Component?

**Decision: Component.**

Remove from `assets/docker-compose.yml`. Create `registry/components/openviking/` with
`compose.yml` + `.env.schema`. Installed on demand like Ollama/SearXNG.

**Affected plans:** knowledge-system-roadmap.md, openpalm-components-plan.md

**Resolves:** H5 (Viking core vs component), C4 (network wiring — handled by component
compose overlay instead of core compose), D1 (container_name non-standard), D2 (image
version pinning — component .env.schema controls the tag).

---

## Q2. CONFIG_HOME Three-Tier Contract

**Decision: ~~Preserve the three-tier XDG model.~~ REVERSED (2026-03-19)**

**Revised decision: Adopt single-root `~/.openpalm/` layout with vault boundary.**

The three-tier XDG model (CONFIG_HOME / DATA_HOME / STATE_HOME) is replaced by a
single `~/.openpalm/` root with semantic subdirectories: `config/` (user-editable
non-secret config), `vault/` (secrets with hard filesystem boundary), `data/`
(service-managed persistent data), and `logs/` (audit/debug output). The staging
tier (STATE_HOME) is eliminated entirely, replaced by validate-in-place with
snapshot rollback.

**Rationale for reversal:** The original Q2 decision was made before the
`fs-mounts-refactor.md` proposal was articulated. The new single-root model
preserves the semantic separation that made the three-tier model valuable (user
config vs system data vs secrets) while eliminating the operational overhead
(31 pre-created directories across 3 filesystem subtrees, 3-hop env file staging
chain, ~21 bind mounts with bulk secret injection). The vault boundary is strictly
more secure than the current `env_file:` model. Agent review consensus: 5/5
unanimous.

**Affected plans:** openpalm-components-plan.md, core-principles.md (major rewrite
needed), openpalm-pass-impl-v3.md (PlaintextBackend must handle two-file model),
CLAUDE.md

**Resolves:** C2 (CONFIG_HOME elimination — now intentional and well-designed),
supersedes the original "preserve three-tier" stance.

**See:** `.github/roadmap/0.10.0/fs-mounts-refactor.md` for the full proposal.

---

## Q3. Secret Management Model

**Decision: Unified secret manager wrapping Varlock.**

A single password manager wraps Varlock and the configured Varlock provider. ALL secrets
go through this system — core secrets, component secrets, and ad-hoc secrets. No separate
plaintext `.env` path for components.

> **Note (2026-03-19):** With the two-file env model adopted in Q11/Q2 reversal, the
> unified secret manager now wraps two files: `vault/user.env` (user-editable LLM keys,
> hot-reloadable) and `vault/system.env` (system-managed tokens, admin-only). The
> PlaintextBackend (Q10) reads/writes these two files rather than the single `secrets.env`
> originally envisioned. Component-level secrets marked `@sensitive` in `.env.schema` are
> routed to the appropriate vault file based on whether they are user-managed or
> system-managed.

**Affected plans:** openpalm-pass-impl-v3.md (major revision — must support component
and ad-hoc secrets, not just global), openpalm-components-plan.md (component `.env.schema`
must integrate with the unified secret manager).

**Resolves:** H1 (missing secrets — all secrets flow through one system), H2 (component
secrets model unreconciled — now reconciled under unified manager).

---

## Q4. Admin OpenCode Instance Token

**Decision: ADMIN_TOKEN — full admin-level agent.**

The admin OpenCode instance (#304) is an admin-level agent embedded in the admin container.
It assists the user directly via the OpenCode web UI at `localhost:3881`. It gets full admin
API access by design — this is NOT a violation of assistant isolation because it IS an
admin agent, not the assistant. The user accesses it directly (same pattern as the assistant
at `localhost:3800`) — no broker, no intermediary, no session proxying.

**Affected plans:** knowledge-system-roadmap.md, openpalm-pass-impl-v3.md

**Resolves:** H7 (broker token undefined). Direct access model — no broker needed.

---

## Q5. Degraded Mode if #304 Is Delayed

**Decision: Shell automation type.**

Extend the automation system's `shell` action type to run eval and maintenance scripts
directly. No OpenCode dependency. Eval suites and maintenance tasks are shell-executable
with appropriate env access. The admin instance calls these later when available, but
they work standalone via scheduled automations.

**Affected plans:** knowledge-system-roadmap.md (Phases 3 and 4C need fallback paths)

**Resolves:** H3 (33% of roadmap blocked on unbuilt #304).

---

## Q6. Q-Value Storage

**Decision: OpenPalm memory service. Viking stays optional add-on.**

Q-values (MemRL retrieval quality scores) are stored as procedural memories in
`@openpalm/memory` with resource URIs as keys. OpenViking is an optional component —
the core knowledge/learning system must not hard-depend on it. Viking enhances search
and context retrieval when installed but the learning lifecycle works without it.

**Affected plans:** knowledge-system-roadmap.md (must decouple Viking dependency from
core learning features)

**Resolves:** M3 (Q-value cross-system coupling — coupling is acceptable since memory
is the primary store, not Viking).

---

## Q7. Automations in the Unified Registry

**Decision: Keep automations separate.**

Automations remain their own registry mechanism (`registry/automations/`). Components
are containers; automations are scheduled tasks. Different concerns, different registries.
The unified registry plan covers components only.

**Affected plans:** openpalm-unified-registry-plan.md (add explicit statement that
automations are out of scope)

**Resolves:** M4 (automation registry orphaned — intentionally separate).

---

## Q8. Legacy Channel Migration

**Decision: Clean break — no migration, no coexistence.**

The legacy `CONFIG_HOME/channels/*.yml` format is dropped entirely. Components are the
only path for 0.10.0. No migration tool, no dual-format staging pipeline. Users must
reinstall channels as components.

**Affected plans:** openpalm-components-plan.md (remove any coexistence language, document
the clean break)

**Resolves:** M5 (no migration path — intentionally none needed).

---

## Q9. ov.conf Placement

**Decision: ~~DATA_HOME.~~ Updated (2026-03-19): `vault/ov.conf`.**

The original decision placed `ov.conf` in DATA_HOME. With the single-root filesystem
refactor (Q2 reversal, Q11), this needs to be reconciled. The `ov.conf` file contains
`root_api_key` (a secret) and `EMBEDDING_API_KEY`, so it belongs in the vault boundary —
not in `data/` where any service could read it. The `fs-mounts-refactor.md` directory
layout explicitly places it at `vault/ov.conf`.

Since Viking is a component (Q1), the admin mediates writes to `vault/ov.conf`. The
admin mounts `vault/` rw. Admin UI can update embedding provider config. The assistant
does NOT need access to `ov.conf` — it communicates with Viking via HTTP API, not by
reading its config file.

**Affected plans:** knowledge-system-roadmap.md, fs-mounts-refactor.md

**Resolves:** M2 (ov.conf placement).

---

## Q10. Password Manager First-Boot Experience

**Decision: Wizard prompts choice.**

The setup wizard asks "Enable encrypted secrets?" during first boot. If yes, guides
through GPG key setup. If no, uses a plaintext backend. User makes an informed choice.
The plaintext backend ensures zero-friction fallback and non-breaking upgrades.

> **Note (2026-03-19):** With the two-file env model (Q11), `PlaintextBackend` is the
> default backend and manages `vault/user.env` + `vault/system.env` directly. These
> files have `0o600` permissions (Phase 0 hardening). When the user opts into encrypted
> secrets, the `PassBackend` wraps these same two files with GPG encryption via `pass`.
> The two-file split is orthogonal to the backend choice — both PlaintextBackend and
> PassBackend operate on the same vault file pair.

**Affected plans:** openpalm-pass-impl-v3.md (must implement PlaintextBackend as default
+ wizard integration for GPG opt-in)

**Resolves:** H6 (no upgrade fallback — PlaintextBackend is the fallback).

---

## Cascading Implications

These decisions create several cascading changes beyond the direct fixes:

1. **Viking as component** means the knowledge roadmap's entire Phase 1A (Viking
   integration) is really "create the Viking component + install it" rather than
   "wire up a core service." The compose overlay, .env.schema, healthcheck, and
   assistant_net attachment all come from the component directory.

2. **Unified secret manager** is a bigger scope than the original pass plan. It must:
   - Support per-component secret resolution (not just global secrets.env)
   - Provide ad-hoc secret storage API (for assistant-discovered credentials, etc.)
   - Integrate with the component lifecycle (secrets provisioned on install, cleaned on delete)

3. **ADMIN_TOKEN for admin instance** simplifies the design — no broker needed.
   No new token type, no mediation layer. But it means the admin UI must isolate the
   embedded OpenCode instance's UI context carefully (it has admin power but should
   present as a helpful assistant to the user).

4. **Clean break for channels** means 0.10.0 is a breaking release for anyone with
   custom channels. The upgrade path is: uninstall old channels, upgrade, reinstall
   as components. This needs prominent documentation in release notes.

5. **Memory service for Q-values** means the memory service needs a new "Q-value"
   memory type or a metadata field on procedural memories for numeric scoring.
   The existing positive/negative feedback becomes the reward signal for MemRL.

6. **Shell automation fallback** means eval suites must be CLI-executable scripts,
   not just OpenCode tool calls. This is actually a better design — eval as
   portable scripts that any automation or agent can invoke.

7. **Single-root filesystem** (Q11) is the most far-reaching cascading change. It
   touches every path constant, every bind mount, every compose file, dev-setup.sh,
   the CLI install command, the admin's staging pipeline (eliminated), and
   core-principles.md (major rewrite). It also simplifies backup (`tar czf backup.tar.gz
   ~/.openpalm`) and eliminates the entire `staging.ts` module.

---

## Q11. Filesystem Layout

**Decision: Adopt single-root `~/.openpalm/` layout. (2026-03-19, 5/5 unanimous)**

All five review agents unanimously approved replacing the three-tier XDG model
(CONFIG_HOME / DATA_HOME / STATE_HOME) with a single `~/.openpalm/` root. This
decision subsumes and formalizes the Q2 reversal.

**Six core decisions:**

1. **Single root `~/.openpalm/`** — collapse three XDG trees into one directory with
   semantic subdirectories: `config/` (user-editable non-secret config), `vault/`
   (secrets with hard filesystem boundary), `data/` (service-managed persistent data),
   `logs/` (audit/debug output). Ephemeral cache at `~/.cache/openpalm/`.

2. **Vault boundary** — `vault/user.env` (user-editable LLM keys, hot-reloadable) +
   `vault/system.env` (system-managed tokens, admin-only write). Admin mounts full
   `vault/` rw; assistant mounts only `vault/user.env` ro (file-level bind mount);
   no other container mounts anything from vault. Secrets reach other containers
   exclusively via `${VAR}` substitution at container creation time.

3. **Staging elimination** — replace the CONFIG_HOME -> STATE_HOME copy pipeline with
   validate-in-place + `~/.cache/openpalm/rollback/` snapshot. Apply writes to live
   paths only after validation passes. Rollback is explicit (`openpalm rollback`) and
   automated on deployment failure.

4. **Two-file env model** — `--env-file vault/system.env --env-file vault/user.env` for
   compose substitution. No comment-separator convention, no staged copies. System.env
   holds admin token, HMAC secrets, paths, UID/GID, image tags. User.env holds LLM keys,
   provider URLs, embedding config.

5. **Hot-reload** — assistant file watcher on `vault/user.env`. Editing LLM keys on the
   host takes effect within seconds. No container restart, no lost context.

6. **0.10.0 scope** — this is a breaking change that ships in 0.10.0. The `openpalm
   migrate` tool handles XDG-to-`~/.openpalm/` transition (env file splitting, directory
   relocation, validation). Guardian restarts on channel install (~2 seconds) since HMAC
   secrets come from `${VAR}` substitution only (no bind-mounted secrets file).

**Affected plans:** core-principles.md (major rewrite — completed), openpalm-components-plan.md
(path references), openpalm-pass-impl-v3.md (PlaintextBackend handles two-file model),
CLAUDE.md (XDG references), all compose files, dev-setup.sh, CLI staging pipeline
(eliminated).

**Resolves:** C2 (CONFIG_HOME elimination — now intentional), M2 (ov.conf placement —
vault/ov.conf), M8 (secrets.env contract — replaced by two-file vault model), M9
(staged permissions — staging eliminated entirely).

**See:** `fs-mounts-refactor.md` for full proposal, `fs-layout.md` for directory tree
reference, `docs/technical/core-principles.md` for the updated architectural rules.
