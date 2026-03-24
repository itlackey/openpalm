# OpenPalm 0.10.0 — Cross-Plan Alignment Review Report

> **Note (2026-03-19):** Many findings below reference the three-tier XDG model
> (CONFIG_HOME/DATA_HOME/STATE_HOME) which has been replaced by the single-root
> `~/.openpalm/` layout. See `fs-mounts-refactor.md` and `review-decisions.md`
> Q2 (reversed) and Q11 (FS refactor adoption). The findings remain valid as
> historical context but the specific path references are outdated.

Three review agents analyzed the 0.10.0 plan documents against each other and
against `docs/technical/authoritative/core-principles.md`. This report consolidates all
findings by severity.

---

## CRITICAL — Must Fix Before Implementation

### C1. Template Rendering Violations

**Affects:** knowledge-system-roadmap.md, openpalm-components-plan.md

Core principle #5: *"No template rendering — manage configuration by copying
whole files, not by string interpolation or code generation."*

**Knowledge roadmap** — The `ov.conf` template contains literal `${VARIABLE}`
substitution placeholders (`${EMBEDDING_MODEL}`, `${EMBEDDING_API_KEY}`,
`${OPENVIKING_API_KEY}`, `${EMBEDDING_DIMS}`). The prose claims "file-assembly,
not template rendering" but the code example IS a template.

**Components plan** — Describes "straightforward find-and-replace on copy" that
resolves `${INSTANCE_ID}`, `${INSTANCE_DIR}`, `${INSTANCE_STATE_DIR}` inside
compose files. This is string interpolation by another name.

**Fix:** Both must use programmatic file assembly. For `ov.conf`: build a JSON
object in TypeScript, serialize it, write the whole file (same pattern as
`generateFallbackStackEnv()` in staging.ts). For components: use Compose-native
`--env-file` substitution — put `INSTANCE_ID=discord-main` in the instance
`.env` file and reference `${INSTANCE_ID}` in compose (resolved by Compose at
runtime, not by admin code at staging time).

### C2. CONFIG_HOME Elimination Breaks Three-Tier Contract

**Affects:** openpalm-components-plan.md

The components plan proposes merging CONFIG_HOME into DATA_HOME ("drop separate
`${OP_CONFIG_HOME}`"). This fundamentally changes the three-tier XDG model
in core-principles.md:

- CONFIG_HOME = user-owned, persistent source of truth
- DATA_HOME = admin- and service-writable durable data
- STATE_HOME = assembled runtime, freely overwritten

Merging them means user configuration files (`.env`) live in a directory the
admin and services can freely write to, losing the "user-owned" protection.
The "allowed writers" rule can no longer be enforced by tier boundaries.

**Fix:** Either formally revise core-principles.md with rationale for why the
three-tier model is being abandoned, or preserve CONFIG_HOME for user `.env`
files while putting compose definitions and persistent data in DATA_HOME.

### C3. Contradictory Service Models Across Plans

**Affects:** knowledge-system-roadmap.md vs openpalm-components-plan.md

The knowledge roadmap describes MCP as a "configurable service" delivered via
`registry/services/mcp.yml` with a flat YAML schema (name, image, port,
environment, caddy). The components plan explicitly states "No channel/service
distinction" — everything is a "component" with a standard compose overlay
directory structure.

These are two different formats and two different installation mechanisms. The
knowledge roadmap appears to be written against an older design (stack spec v3's
`StackServiceConfig`) while the components plan supersedes it.

**Fix:** Rewrite the knowledge roadmap's MCP service definition as a standard
component directory (`registry/components/mcp/compose.yml` + `.env.schema`),
following the components plan's conventions. The inline `caddy:` field becomes a
separate `.caddy` file in the component directory.

### C4. OpenViking Not Reachable — Network Wiring Missing

**Affects:** knowledge-system-roadmap.md, docker-compose.yml

The `openviking` service in `assets/docker-compose.yml` has no `networks:`
declaration, meaning it joins the default network (NOT `assistant_net`). The
assistant container is on `assistant_net` only. They cannot communicate.

Phase 1A of the knowledge roadmap correctly identifies this fix, but the plan
should not describe Viking as "already deployed" until the network is wired.

**Fix:** Add `networks: [assistant_net]` to the `openviking` service. Ensure it
is NOT added to `channel_lan` or `channel_public` to maintain segmentation.

---

## HIGH — Should Fix Before Release

### H1. Missing Secrets in Password Manager

**Affects:** openpalm-pass-impl-v3.md vs knowledge-system-roadmap.md

The password plan's `ENV_TO_SECRET_KEY` map and `SECRET_KEYS` set are missing
three secrets the knowledge roadmap introduces:

| Secret | Introduced By | In Pass Plan? |
|--------|--------------|:---:|
| `OPENVIKING_API_KEY` | Knowledge roadmap Phase 1A.3 | No |
| `MCP_API_KEY` | Knowledge roadmap Phase 2B | No |
| `EMBEDDING_API_KEY` | Knowledge roadmap ov.conf | No |

**Fix:** Add all three to `ENV_TO_SECRET_KEY`, `SECRET_KEYS`,
`secrets.env.schema`, `pass-init.sh`, and `migrate-to-pass.sh`.

### H2. Component Secrets Model Unreconciled

**Affects:** openpalm-pass-impl-v3.md vs openpalm-components-plan.md

The components plan gives each instance its own `.env` file at
`DATA_HOME/components/<instance>/.env`. The password plan centralizes secrets in
`DATA_HOME/secrets/pass-store/`. These aren't reconciled.

Questions that need answers:
- Do component-level secrets (e.g., `DISCORD_BOT_TOKEN`) go through pass?
- If components use pass, how does the per-component `.env.schema` relate to
  the central `secrets.env.schema`?
- The component's `compose.yml` uses `env_file: ${INSTANCE_DIR}/.env` — how
  does Varlock bridge these?

**Fix:** Take a position. Recommended: Component secrets stay as plaintext `.env`
files (per-instance isolation, simple). Pass handles only global secrets (admin
token, LLM keys). Component `.env` files get `0o600` permissions.

### H3. 33% of Knowledge Roadmap Blocked on Unbuilt #304

**Affects:** knowledge-system-roadmap.md

8 of 24 working days (Phases 3 and 4C) depend entirely on the brokered admin
OpenCode instance (#304), which has no code written yet. There is no fallback.

**Fix:** Define a degraded mode for eval and maintenance that can run without
the brokered instance (e.g., admin API endpoints that run eval suites directly,
or `shell` action type with extended env allowlist).

### H4. No Caddy Route Mechanism for Components

**Affects:** openpalm-components-plan.md

The current system has a well-defined Caddy staging pipeline
(`stageChannelCaddyfiles`) that enforces LAN-first by default. The components
plan does not describe:
- Where component `.caddy` files live
- How they are discovered and staged
- Whether LAN-first default is enforced
- How Caddy reloads when a new component is enabled

**Fix:** Define the Caddy route mechanism for components. Each component
directory should have an optional `.caddy` file. The staging pipeline should
discover and stage them with LAN-first enforcement (matching current behavior).

### H5. OpenViking: Core Service or Component?

**Affects:** knowledge-system-roadmap.md vs openpalm-components-plan.md

OpenViking is hardcoded in `assets/docker-compose.yml` as a core service, but:
- It's not in the `CORE_SERVICES` array in `types.ts`
- It has no healthcheck in compose
- It's not included in `buildManagedServices()`
- The components plan says Ollama, SearXNG, etc. should be components

If Ollama is a component (optional, overlay-based), OpenViking should be too.

**Fix:** Decide: either make OpenViking a component (consistent with components
plan — remove from core compose, create component directory) or add it to
`CORE_SERVICES` with lifecycle integration. The knowledge roadmap should reflect
whichever decision is made.

### H6. No Upgrade Fallback for Password Manager

**Affects:** openpalm-pass-impl-v3.md

The migration to pass is manual (`openpalm secrets migrate`). If a user
upgrades to 0.10.0 but doesn't run migration, and no pass store exists, the
`detectProvider()` function may fail.

**Fix:** Add a `PlaintextBackend` (or `EnvFileBackend`) as the default when no
pass store is initialized. Zero-breaking-change upgrade path. This also solves
the setup wizard first-boot problem (GPG setup doesn't fit a web wizard flow).

### H7. Brokered Instance Token Undefined

**Affects:** openpalm-pass-impl-v3.md vs knowledge-system-roadmap.md

Neither plan specifies what token the brokered admin instance (#304) receives.
Options:
- `ADMIN_TOKEN` — can write secrets, violates assistant isolation principle
- `ASSISTANT_TOKEN` — can't run admin-authorized operations
- `BROKER_TOKEN` — new token type, needs permission scope definition

**Fix:** Define the brokered instance's token type explicitly. Recommended:
`ASSISTANT_TOKEN` for operational access. The broker module mediates admin-level
operations on behalf of the instance (the instance requests, the broker
authorizes and executes). This maintains assistant isolation while granting
admin API access through the broker.

---

## MODERATE — Should Address

### M1. Viking Workspace Nested Under Memory Directory

**Affects:** knowledge-system-roadmap.md, docker-compose.yml

Viking workspace is at `DATA_HOME/memory/workspace`, conflating Viking's data
with `@openpalm/memory` sqlite-vec data. Creates backup/restore ambiguity.

**Fix:** Move to `DATA_HOME/openviking/workspace`.

### M2. ov.conf Placement (CONFIG_HOME vs DATA_HOME)

**Affects:** knowledge-system-roadmap.md

If `ov.conf` is in CONFIG_HOME, the non-destructive lifecycle rule means
automatic operations can only seed it if missing, never overwrite it. This
creates a problem if the user changes embedding provider via admin UI.

**Fix:** Place in `DATA_HOME/openviking/ov.conf` (admin-managed, like
`DATA_HOME/caddy/Caddyfile`). Admin mediates writes. Advanced users can still
access it since DATA_HOME is user-accessible.

### M3. Q-Value Cross-System Coupling

**Affects:** knowledge-system-roadmap.md

Storing Q-values in @openpalm/memory with Viking URIs as foreign keys creates:
- Orphan entries if Viking resources are renamed/deleted
- Dual-write consistency requirements
- N+1 query problem when looking up Q-values for search results

**Fix:** Consider storing Q-values in Viking's own metadata (if supported), or
in a lightweight local SQLite table, or batch-fetch Q-values from memory to
avoid N+1.

### M4. Automation Registry Orphaned

**Affects:** openpalm-unified-registry-plan.md

The unified registry plan only covers components. The current
`registry/automations/` directory and its loading mechanism are not mentioned.

**Fix:** Clarify whether automations remain as a separate registry mechanism or
get folded into the component model.

### M5. No Migration Path for Existing Channel Installations

**Affects:** openpalm-components-plan.md

Legacy channels installed at `CONFIG_HOME/channels/chat.yml` will coexist with
new components at `DATA_HOME/components/chat/compose.yml`. No migration path
described.

**Fix:** Define a migration tool or document the coexistence strategy. The
staging pipeline needs to handle both formats during transition.

### M6. Compose Service Name Collision Prevention

**Affects:** openpalm-components-plan.md

No prefix convention defined for component service names. A component named
`memory` would collide with the core `memory` service.

**Fix:** Define a prefix convention (e.g., `op-{instanceId}`) and validate
against `CORE_SERVICES` on instance creation.

### M7. Assistant Container Missing Viking Environment Variables

**Affects:** knowledge-system-roadmap.md

The assistant container's environment block has no `OPENVIKING_URL` or
`OPENVIKING_API_KEY`. The proposed `vikingFetch()` helper needs these.

**Fix:** Add to the assistant's environment section in compose.

### M8. CONFIG_HOME Contract Change After Pass Migration

**Affects:** openpalm-pass-impl-v3.md

Post-migration, `CONFIG_HOME/secrets.env` no longer exists (renamed to
`.migrated`). Core-principles.md says CONFIG_HOME contains `secrets.env`.

**Fix:** Update core-principles.md to reflect that CONFIG_HOME holds
`secrets.env.schema` (resolver declarations) rather than plaintext values after
migration.

### M9. Staged secrets.env Permissions Incomplete

**Affects:** openpalm-pass-impl-v3.md

Phase 0.1 adds `mode: 0o600` to the staged `secrets.env`, but
`DATA_HOME/stack.env` (also contains channel HMAC secrets) doesn't get the same
treatment.

**Fix:** Apply `0o600` to `DATA_HOME/stack.env` as well.

---

## MINOR / DOCUMENTATION

### D1. `container_name: openviking` is non-standard
Other services don't use explicit `container_name`. May cause issues with
Compose multi-project namespacing.

### D2. Viking image not version-pinned
Using `:latest` for a third-party image. Pin to a specific version for
reproducible upgrades.

### D3. `compose.yml` vs `docker-compose.yml` naming inconsistency
Components plan uses `compose.yml`, core stack uses `docker-compose.yml`. Both
valid but should be documented.

### D4. No archive retention or restore policy for components
Deleted component instances archive to `DATA_HOME/archived/` with no retention
or restore mechanism defined.

### D5. Docker volumes not cleaned up on component deletion
Components may create Docker volumes. The delete flow doesn't mention cleanup.

### D6. GPG agent socket trust boundary
Host GPG agent socket mounted into admin container lets it decrypt any
GPG-encrypted content the host user can, not just OpenPalm secrets. Document
in security appendix.

### D7. Backup/restore now requires GPG key
After pass migration, restoring a backup requires the GPG private key on the
restore target. New requirement not present in plaintext model.

### D8. Enabled component instance list persistence
The components plan doesn't specify where the enabled instance list is persisted
or how it survives admin container restarts.

### D9. Registry uninstall impact on existing instances
Removing a catalog entry doesn't address what happens to instances created from
it. Are they orphaned?

---

## Open Questions Requiring Decisions

All questions have been resolved. See [review-decisions.md](review-decisions.md) for full details.

| # | Question | Affects | Status |
|---|----------|---------|--------|
| Q1 | Is OpenViking a core service or a component? | Knowledge, Components | RESOLVED — Component. [Q1](review-decisions.md#q1-openviking-core-service-or-component) |
| Q2 | Does CONFIG_HOME survive as a separate tier, or merge into DATA_HOME? | Components, Core Principles | RESOLVED — Single-root `~/.openpalm/` replaces three-tier XDG. [Q2](review-decisions.md#q2-config_home-three-tier-contract) (reversed), [Q11](review-decisions.md#q11-filesystem-layout) |
| Q3 | Do component-level secrets go through pass or stay as plaintext .env? | Password, Components | RESOLVED — Unified secret manager wraps Varlock; all secrets flow through it. [Q3](review-decisions.md#q3-secret-management-model) |
| Q4 | What token type does the brokered instance (#304) receive? | Password, Knowledge | RESOLVED — ADMIN_TOKEN (full admin-level agent). [Q4](review-decisions.md#q4-brokered-admin-instance-token) |
| Q5 | What is the degraded mode if #304 is delayed? | Knowledge (eval + maintenance) | RESOLVED — Shell automation type as fallback. [Q5](review-decisions.md#q5-degraded-mode-if-304-is-delayed) |
| Q6 | Where do Q-values live — memory metadata, Viking metadata, or local SQLite? | Knowledge | RESOLVED — OpenPalm memory service. [Q6](review-decisions.md#q6-q-value-storage) |
| Q7 | How are automations handled in the unified registry? | Registry | RESOLVED — Keep automations separate. [Q7](review-decisions.md#q7-automations-in-the-unified-registry) |
| Q8 | What is the migration strategy for legacy channel installations? | Components | RESOLVED — Clean break, no migration. [Q8](review-decisions.md#q8-legacy-channel-migration) |
| Q9 | Should ov.conf live in CONFIG_HOME or DATA_HOME? | Knowledge, Core Principles | RESOLVED — `vault/ov.conf` (contains secrets). [Q9](review-decisions.md#q9-ovconf-placement) (updated) |
| Q10 | What is the first-boot experience for the password manager? | Password | RESOLVED — Wizard prompts choice; PlaintextBackend default. [Q10](review-decisions.md#q10-password-manager-first-boot-experience) |

---

## Cross-Reference Matrix

Shows which plans need updates based on each finding:

| Finding | Knowledge | Components | Registry | Password | Core Principles |
|---------|:---------:|:----------:|:--------:|:--------:|:---------------:|
| C1 Template rendering | X | X | | | |
| C2 CONFIG_HOME elimination | | X | | | X |
| C3 Contradictory service models | X | X | | | |
| C4 Viking network | X | | | | |
| H1 Missing secrets | | | | X | |
| H2 Component secrets model | | X | | X | |
| H3 #304 dependency | X | | | | |
| H4 Caddy for components | | X | | | |
| H5 Viking core vs component | X | X | | | |
| H6 Upgrade fallback | | | | X | |
| H7 Broker token | X | | | X | |
| M1 Viking data path | X | | | | |
| M2 ov.conf placement | X | | | | X |
| M3 Q-value coupling | X | | | | |
| M8 secrets.env contract | | | | X | X |
