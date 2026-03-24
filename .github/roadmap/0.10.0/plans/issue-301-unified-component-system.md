# Issue #301: Unified Addon Model

> Current repo alignment: the home-rooted layout and shared-lib control-plane refactor have already landed substantially. Read this plan as an addon-model follow-on plan against the current `.openpalm/stack/`, `vault/user/user.env`, `vault/stack/stack.env`, and `packages/lib/src/control-plane/` architecture rather than against the older flat-vault or XDG/staging model.

> **Terminology update:** The improved design now uses **addon** as the user-facing term. Historical references to `component` in APIs, paths, and earlier notes describe the same runtime model.

## Scope and dependency summary

- Issue #301 delivers the v0.10.0 addon model: every optional stack capability becomes an addon with a standardized directory contract (`compose.yml`, `.env.schema`, optional `.caddy`), instance lifecycle support, registry integration, admin UI/API, and CLI workflows.
- The roadmap places two shared prerequisites on the critical path before the main #301 feature work: the filesystem refactor to `~/.openpalm/` and 38XX port standardization. Those changes are required for #301 to land cleanly, but they are broader platform work and should be tracked as shared prerequisite work even when implemented in the same branch/release train.
- Control-plane logic for both prerequisite work and #301 must live in `packages/lib/` first. CLI and admin stay thin wrappers over `@openpalm/lib`; no new lifecycle/discovery/configuration logic should be added directly to `packages/cli/` or `packages/admin/`.
- #301 also depends on concurrent secrets/auth changes from roadmap issue #300 where addon config touches `@sensitive` fields, token splits, and the nested vault model (`vault/user/user.env` plus `vault/stack/stack.env`). The addon plan should define clean handoff points rather than duplicating that implementation.
- Keep the ownership split from `docs/technical/authoritative/core-principles.md` explicit: `config/openpalm.yml` remains the user-editable stack config, `.openpalm/stack/core.compose.yml` and `.openpalm/stack/addons/*/compose.yml` remain the system-managed runtime assembly, and any `data/components/` instance copies or `data/components/enabled.json` state are service-managed runtime artifacts rather than a second user-facing config authority.

## Delivery boundaries

### Shared prerequisite work (critical path, not exclusive to #301)

- Replace XDG path helpers and staging-era assumptions with `OP_HOME` / `~/.openpalm/`, `config/`, `vault/`, `data/`, `logs/`, and cache-backed rollback snapshots.
- Remove the permanent staging pipeline in favor of validate-in-place plus rollback.
- Standardize service ports to the 38XX range and update compose files, Caddy upstreams, health checks, tests, and setup scripts.
- Split env handling into `vault/stack/stack.env` and `vault/user/user.env`, with assistant hot-reload from `vault/user/user.env` and strict vault mount boundaries.

### Issue #301 work proper

- Replace the legacy channel/service distinction with addon definitions, catalog discovery, instance directories, `enabled.json` persistence, and compose overlay assembly from enabled instances.
- Add addon lifecycle operations across `@openpalm/lib`, CLI, admin API, and admin UI.
- Move registry structure and validation from `registry/channels/` to `registry/components/`, with multi-instance metadata sourced from the addon directory itself instead of bespoke UI logic.
- Enforce the clean break from legacy channels with no migration path and no dual runtime model.

## Phased implementation plan

### Phase 0 - Shared prerequisites: filesystem, rollback, and ports

1. Create the new home-path abstraction in `packages/lib/`.
   - Replace `packages/lib/src/control-plane/paths.ts` with a new home-rooted module (`home.ts` or equivalent) that resolves `OP_HOME`, cache paths, `config/components/`, `vault/`, `data/components/`, `data/caddy/`, `logs/`, and rollback directories.
   - Update `packages/lib/src/index.ts`, `packages/cli/src/lib/paths.ts`, and `packages/admin/src/lib/server/control-plane.ts` to re-export the new helpers without preserving XDG-specific naming in new code.
   - Add compatibility detection helpers for legacy `OP_CONFIG_HOME`, `OP_DATA_HOME`, and `OP_STATE_HOME` so CLI and admin can warn instead of silently diverging.
2. Eliminate the permanent staging pipeline.
   - Replace staging-centric flows in `packages/lib/src/control-plane/staging.ts`, `packages/lib/src/control-plane/lifecycle.ts`, and `packages/cli/src/lib/staging.ts` with validate-in-place operations that snapshot live files to `~/.cache/openpalm/rollback/` before writes.
   - Preserve non-destructive user config semantics from the architecture rules: automatic operations seed missing files only, while explicit admin/CLI actions may mutate requested files.
   - Introduce a first-class rollback command path in lib and CLI so deploy failures can restore snapshots consistently.
3. Convert core assets and setup scripts to the new filesystem contract.
    - Keep runtime assembly aligned with `.openpalm/stack/core.compose.yml`, `.openpalm/stack/addons/admin/compose.yml`, and the nested vault model instead of the older asset/staging layout.
   - Update `scripts/dev-setup.sh` to seed `~/.openpalm/` layout, both vault env files, and cache directories.
    - Ensure the assistant mounts only `vault/user/user.env` read-only and no non-admin service mounts the full vault directory.
4. Perform port standardization as part of the same asset rewrite.
   - Update compose service definitions, env defaults, Caddy upstreams, and health checks to assistant `3800`, chat `3820`, admin `3880`, admin-opencode `3881`, scheduler `3897`, memory `3898`, guardian `3899`, and ingress default `3880`.
   - Sweep code, docs, and tests for old `4096`, `4097`, `8100`, `8080`, `8090`, and `8765` assumptions.
   - Keep this work explicitly tagged as shared prerequisite infrastructure so it does not get lost inside later component-specific review.

### Phase 1 - Shared library component domain model

1. Add component and instance types to `packages/lib/`.
   - Define types for component definitions, catalog sources, parsed schema fields, enabled instances, instance status, health metadata, Caddy route presence, and component overlay extensions.
   - Model component identities around source component id plus user-chosen instance id; reserve core service names and validate collisions up front.
2. Build component discovery in lib.
   - Scan built-in components, registry components, and user-local catalog directories for directories containing `compose.yml` and `.env.schema`.
   - Read compose labels for display metadata (`openpalm.name`, `openpalm.description`, `openpalm.icon`, `openpalm.category`, `openpalm.docs`, `openpalm.healthcheck`).
   - Add validation that component overlays do not violate architectural guardrails, especially no guardian bypass and no forbidden vault mounts.
3. Build instance persistence and compose assembly in lib.
    - Persist enabled instances in `data/components/enabled.json` as a system-managed runtime index/cache, with fallback recovery when the file is missing or corrupted.
    - Keep `config/openpalm.yml` as the user-facing stack configuration source of truth; explicit CLI/admin lifecycle actions should update any component-enabled state there as needed, while startup repair may rebuild `enabled.json` from live instance directories and stack config.
    - Create helpers that assemble compose args in the new order: vault env files first, `.openpalm/stack/core.compose.yml` and enabled addon overlays next, then enabled component instance overlays with each instance `.env`.
    - Replace channel-based service allowlist logic with instance-aware allowlists (`openpalm-{instanceId}` and any documented singleton exceptions).
4. Support cross-component environment injection safely.
   - Allow component overlays to extend approved core services such as `assistant` via normal Compose merge behavior.
   - Add collision detection for duplicate env var injection into the same core service and fail validation before deploy.
   - Explicitly forbid component overlays from mutating guardian/admin security boundaries beyond approved extension points.

### Phase 2 - Instance lifecycle, validation, and secrets integration

1. Implement instance create/configure/start/stop/restart/delete/archive in `packages/lib/`.
   - Create instance directories under `data/components/{instanceId}/` by copying the full source component directory without rewriting `compose.yml`.
   - Write instance identity variables to `.env` (`INSTANCE_ID`, `INSTANCE_DIR`) and seed non-sensitive defaults from `.env.schema`.
   - Copy `.caddy` snippets into `data/caddy/channels/` only for enabled/running instances, and remove them on stop/delete.
2. Integrate with the new secrets backend contract.
   - For non-sensitive fields, persist values in the instance `.env`.
   - For `@sensitive` fields, store values through the shared secret backend namespace (`components/{instanceId}/{KEY}` or final agreed convention) and keep plaintext out of instance env files.
   - Coordinate with #300 so component lifecycle can read/update/delete secret-backed fields without reimplementing backend logic inside #301.
3. Replace channel-specific mutation flows.
    - Retire lib functions and admin wrappers built around `discoverChannels`, `installChannelFromRegistry`, and staged channel overlays.
    - Do not keep dual runtime models or migration shims.
4. Add clean-break lifecycle behaviors.
   - Deleting an instance should stop it, remove secret namespace entries, clean up route snippets, update `enabled.json`, and archive the instance directory to a recoverable location.
   - Starting/stopping should rebuild the compose chain from `enabled.json` rather than operating only on detached one-off container names.

### Phase 3 - Admin API and server integration

1. Introduce the component API surface.
   - Add `/api/components` and `/api/instances` endpoints in `packages/admin/src/routes/api/` for list, detail, create, update config, start, stop, restart, delete, logs, health, and schema rendering.
   - Keep route handlers transport-only: auth, request parsing, lib call, structured response, audit logging.
   - Preserve request id and caller metadata conventions already used by current admin endpoints.
2. Remove or deprecate channel-specific admin endpoints.
     - Replace `/admin/channels/*` and any remaining legacy registry install/uninstall flows that still assume raw channel overlay files.
    - Return explicit clean-break guidance while the UI and CLI move over.
3. Update admin server types and client contracts.
   - Replace `ChannelInfo`, `ChannelsResponse`, and `RegistryChannelItem`-centric DTOs with component and instance DTOs in `packages/admin/src/lib/types.ts`.
   - Update client helpers in `packages/admin/src/lib/api.ts` to match the new API surface, including schema-driven config forms and instance actions.
4. Keep control-plane extraction discipline.
   - Any server-side helper that still owns reusable lifecycle logic should be moved into `packages/lib/` before the API layer is finalized.

### Phase 4 - CLI commands and install/setup cleanup

1. Extend the CLI command tree.
   - Add `openpalm component list`, `openpalm component instances`, `openpalm component add`, `openpalm component configure`, `openpalm component remove`, `openpalm component start`, and `openpalm component stop` in `packages/cli/src/main.ts` and `packages/cli/src/commands/`.
   - Route all operations through `@openpalm/lib`; CLI-specific work should be argument parsing, prompts, and terminal output only.
3. Update CLI setup/status/install flows.
    - Replace XDG/staging references in install, start, stop, restart, status, validate, logs, and setup-wizard code.
    - Treat detected legacy installs as unsupported and direct users to the clean-break release notes instead of attempting conversion.
4. Rework the setup wizard for component selection.
   - Replace channel/service toggles with optional component selection and per-component config collection.
   - Ensure the wizard can create singleton instances during install without bypassing lib lifecycle rules.

### Phase 5 - Admin UI replacement and form rendering

1. Replace the current Containers plus Registry split with an Addons experience.
    - Update `packages/admin/src/routes/+page.svelte` and related components so the primary workflow becomes a unified Addons tab, grouped by category and instance state.
    - Show available addons, enabled instances, status, docs, logs, restart/remove actions, and multi-instance creation from one screen.
2. Build a schema-driven configuration renderer.
   - Parse `.env.schema` once on the server, return normalized JSON, and render forms for required, optional, defaulted, and `@sensitive` fields.
   - Mask secret-backed values, show provenance/help text, and make validation errors map back to schema fields.
3. Add clean-break UX.
    - Show an unsupported-legacy-install notice when legacy XDG installs or legacy channel overlays are detected.
    - Provide explicit upgrade guidance explaining that legacy channels no longer load directly and must be reinstalled as addons.
4. Update setup wizard UI and supporting components.
   - Replace registry/channel terminology everywhere in the admin client.
   - Keep mobile and desktop behavior usable since this becomes the primary install/configure workflow.

### Phase 6 - Registry, CI, and built-in addon packaging

1. Move the repository catalog to addon directories.
   - Replace `registry/channels/*.yml` plus optional `.caddy` with `registry/components/<name>/compose.yml`, `.env.schema`, and optional `.caddy`.
   - Decide which current assets remain system-managed overlays (`core`, `admin`) versus registry/built-in component templates.
2. Update discovery providers.
   - Replace Vite registry globs and filesystem registry providers that assume flat channel files.
   - Ensure built-time bundling and local filesystem discovery work with the new directory structure and override precedence.
3. Add CI validation for addon submissions.
   - Enforce directory contract, compose label presence, schema parseability, optional Caddy validation, port and mount policy, and forbidden security-boundary violations.
   - Add validation for overlays that extend core services so collisions and unsafe mutations are caught in CI rather than at runtime.
4. Refresh developer-facing registry docs.
    - Rewrite `registry/README.md` and related docs to explain addon authoring, multi-instance expectations, schema usage, and route snippets.

### Phase 7 - Documentation, test updates, and release readiness

1. Update architecture and operator docs.
   - Rewrite docs that still describe channels, XDG roots, staging artifacts, or old port numbers.
    - Add an addon developer guide, clean-break upgrade guide, and release notes for the 0.10.0 breaking changes.
2. Migrate and expand automated tests.
    - Replace channel/staging tests in `packages/lib/` and admin with addon/home-layout/rollback tests.
    - Add unit coverage for discovery, instance lifecycle, `enabled.json`, compose arg order, secret field handling, route staging, legacy-install rejection, and env-injection collisions.
   - Add API tests for the new component endpoints and Playwright or equivalent E2E coverage for create/configure/start/stop/delete and multi-instance flows.
3. Add script and fixture updates.
   - Refresh dev fixtures, mocked compose outputs, Caddy fixtures, and any shell scripts that hardcode old paths or ports.
   - Verify health-check and smoke-test scripts exercise the new API and ingress endpoints.
4. Do a final compatibility sweep.
   - Confirm no user-facing copy, command help, or docs still describe channels as the primary extensibility model.
   - Confirm no new control-plane logic remains stranded in admin or CLI after the refactor.

## Clean-Break Work Breakdown

- Reject legacy XDG and legacy channel layouts as unsupported runtime inputs for 0.10.0.
- Surface clear CLI/admin messaging that 0.10.0 requires a fresh `~/.openpalm/` layout.
- Remove runtime loading of legacy channels entirely; do not run two parallel models.
- Keep the config/data ownership split intact inside the new layout: user-facing intent in `config/openpalm.yml`, derived runtime state in `data/`.

## Acceptance criteria

- The stack runs from the `~/.openpalm/` filesystem contract with validate-in-place deploys, rollback snapshots, and the 38XX port standard.
- The final design preserves the config/data ownership boundary from the core principles: `config/openpalm.yml` is user-owned stack config, while `data/components/` and any `enabled.json` file are system-managed runtime state.
- All portable lifecycle, discovery, validation, path, secrets, and compose-assembly logic for components lives in `packages/lib/` and is reused by CLI and admin.
- Users can discover components, create one or more instances, configure schema-backed values, start/stop/restart/delete instances, and view status from both CLI and admin.
- `@sensitive` component fields use the shared secret backend and do not persist plaintext secrets in instance `.env` files.
- Registry packaging, built-in component discovery, and CI validation all operate on `registry/components/<name>/` directories.
- Legacy channel installs are detected as unsupported, and runtime support for direct `channels/*.yml` loading is removed.
- Automated coverage exists for the new home layout, compose arg ordering, instance lifecycle, legacy-install rejection, registry validation, and UI/API happy paths.

## Risks and mitigation

- Large refactor breadth: filesystem, ports, secrets, CLI, admin, and registry all change together. Mitigate by landing Phase 0 first and keeping lib-level tests green before UI work starts.
- Dual-model temptation: keeping channel codepaths for too long will create divergent behavior. Mitigate by removing legacy runtime loading early and documenting the clean break clearly.
- Security regressions from overlay flexibility: component overlays can become an escape hatch around guardian/vault rules. Mitigate with explicit lib validation plus CI policy checks.
- Secrets integration coupling with #300: if secret backend contracts move late, component config can stall. Mitigate by agreeing early on the lib interface for secret-backed component fields.
- Test churn: staging and channel assumptions are widespread. Mitigate by budgeting explicit rewrite time instead of treating tests as incidental cleanup.

## Relevant files

- `docs/technical/authoritative/core-principles.md:30` - authoritative filesystem contract, lib-first control-plane rule, and service-port assignments.
- `.github/roadmap/0.10.0/README.md:21` - roadmap scope for #301; `.github/roadmap/0.10.0/README.md:65` and `.github/roadmap/0.10.0/README.md:169` - embedded filesystem and port prerequisite work.
- `.github/roadmap/0.10.0/README.md:21` - roadmap scope for #301 and addon terminology; `.github/roadmap/0.10.0/README.md:221` - shared-lib rule.
- `.github/roadmap/0.10.0/fs-mounts-refactor.md:94` - target filesystem layout; `.github/roadmap/0.10.0/fs-mounts-refactor.md:358` - validate/rollback flow; `.github/roadmap/0.10.0/fs-mounts-refactor.md:677` - clean-break direction.
- `packages/lib/src/control-plane/paths.ts:1` - current XDG path resolver to replace with home-rooted helpers.
- `packages/lib/src/control-plane/staging.ts:1` - current staging pipeline to remove or repurpose.
- `packages/lib/src/control-plane/lifecycle.ts:46` - current state creation and compose assembly; `packages/lib/src/control-plane/lifecycle.ts:222` - staged compose file list builder that must become instance-based.
- `packages/lib/src/control-plane/channels.ts:22` - current channel discovery/install model to replace with component discovery and lifecycle.
- `packages/lib/src/index.ts:66` - current shared export surface that will need new home/component APIs.
- `packages/admin/src/lib/server/control-plane.ts:1` - current admin wrapper around `@openpalm/lib`; useful for verifying consumer-thin architecture during refactor.
- `packages/admin/src/routes/+page.svelte:7` - current tabbed UI using Containers and Registry tabs; primary entry point for the Components-tab replacement.
- `packages/admin/src/lib/types.ts:48` - current channel/registry DTOs to replace with component and instance DTOs.
- `packages/cli/src/main.ts:11` - current CLI command tree that needs component and migrate subcommands.
- `packages/cli/src/lib/paths.ts:1` and `packages/cli/src/lib/staging.ts:1` - CLI-side XDG/staging assumptions to remove.
- `.openpalm/stack/core.compose.yml`, `.openpalm/stack/addons/admin/compose.yml`, and the current Caddy/runtime assembly paths - core runtime files carrying current path, port, and routing assumptions.
- `registry/README.md:3` and `registry/channels/chat.yml:1` - current registry structure/documentation to replace with `registry/components/` directories.
