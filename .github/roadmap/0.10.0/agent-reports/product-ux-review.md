# Product & UX Review -- v0.10.0 Milestone

## Summary

v0.10.0 is an ambitious structural overhaul that replaces legacy channels with a unified component system, adds encrypted secrets management, introduces an optional knowledge store (OpenViking), and seeds an eval framework and MemRL feedback loop. The component system is the centerpiece and is well-designed, but the milestone packs at least three breaking-change-grade features (components, registry rewrite, secrets backend) alongside speculative new surface area (voice, knowledge Q-values, eval framework) that collectively risk overwhelming both the upgrade experience and the development timeline. The most immediate user-facing concern is the clean break from legacy channels: without a migration tool or coexistence period, every existing user must manually reinstall their channels -- this needs prominent in-product communication, not just release notes.

---

## Issues Assessment

### #301 -- Configurable Services (Components System)

**UX Impact:** Transformative. This changes the core mental model from "channels + core services" to a flat "everything is a component" abstraction. The admin UI goes from 6 tabs to a Components tab that subsumes much of what Containers and Registry currently do. Users gain multi-instance support (two Discord bots), a standardized config form rendered from `.env.schema`, and the ability to add third-party components by dropping a directory.

**Recommendation: KEEP -- this is the keystone of 0.10.0.**

The plan is thorough and architecturally clean. The compose-native variable resolution via `--env-file` elegantly avoids template rendering. Key UX concerns:

1. **Tab consolidation is under-specified.** The current admin UI has 6 tabs (Overview, Automations, Registry, Connections, Containers, Artifacts). The components plan adds a "Components" tab but does not specify what happens to Containers, Registry, and Artifacts. These tabs partially overlap with the new component model. If all three persist alongside Components, users face a confusing split: "Which tab do I use to manage my Discord bot -- Components, Containers, or Registry?" The plan needs a tab consolidation strategy.

2. **The "New Instance" flow needs progressive disclosure.** The plan shows a picker for available components then a name prompt, but for new users, the distinction between a "component" (a template in the catalog) and an "instance" (a running deployment of that template) is non-obvious. The flow should lead with action-oriented language: "Add Discord Bot" rather than "Create Instance from discord component."

3. **Category grouping requires seeded categories.** The flat list grouped by `openpalm.category` only works if component authors populate the compose label consistently. Built-in components will, but community submissions may not. The UI should handle the "uncategorized" case gracefully.

---

### #300 -- Password Manager (Varlock Improvements)

**UX Impact:** High but mostly invisible when working well. The 7-phase plan introduces a `SecretBackend` abstraction with `PlaintextBackend` as default and `pass` as opt-in. This is the right call. The `@sensitive` annotation in `.env.schema` files gives the component config form a clean way to distinguish masked fields.

**Recommendation: KEEP, but scope to Phases 0-4 for 0.10.0.**

Concerns:

1. **Phase 5 (Password Manager UI) should be deferred.** A full secrets management UI (list, rotate, delete secrets) is a significant standalone feature. For 0.10.0, the component config form's `@sensitive` field handling is sufficient. Users do not need a separate "Password Manager" page on day one -- they need secrets to work transparently when configuring components.

2. **Phase 6 (Connections Endpoint Refactor) should be deferred.** Refactoring the connections system while simultaneously rebuilding channels as components creates too many simultaneous breaking changes. Ship the new component secret flow; refactor connections in 0.10.1.

3. **Phase 1 (ADMIN_TOKEN / ASSISTANT_TOKEN split) is a breaking change that compounds with the components breaking change.** Existing scripts, automations, and documentation all use a single `ADMIN_TOKEN`. Splitting it to two token types in the same release that removes legacy channels risks a painful upgrade. Consider deferring the split to 0.10.1 and using ADMIN_TOKEN for the brokered instance in 0.10.0 (as the review-decisions.md already recommends for Q4).

4. **GPG setup does not fit a web wizard.** The plan acknowledges this in Q10, and the PlaintextBackend default handles it. But the wizard prompt "Enable encrypted secrets?" needs clear help text explaining what GPG is, why a user would want it, and that they can enable it later. Otherwise it is a confusing binary choice for non-security-specialist users.

---

### #298 -- Add OpenViking Integration

**UX Impact:** Moderate for 0.10.0 users. OpenViking is an optional component that enhances the assistant's knowledge capabilities. Most users will not install it on day one. The real value is for power users who want structured knowledge management.

**Recommendation: KEEP as a component, but DEFER the knowledge system roadmap's Phases 3-4 (eval framework, MemRL Q-values).**

Concerns:

1. **The knowledge-system-roadmap.md is a 24-day plan within a milestone that already has 6 other issues.** The Viking component definition (Phase 1A, 1 day) and assistant tools (Phase 1B, 2 days) are reasonable for 0.10.0. The eval framework (6 days), Q-value tracking (6 days), and automated maintenance (in Phase 4C) are research-grade features that should be a separate milestone (0.11.0 or a "knowledge system" epic).

2. **Session memory extraction (Phase 1C) has significant risk.** Hooking into OpenCode session lifecycle events to POST to a Viking API introduces latency and failure modes in the critical assistant response path. This needs graceful degradation testing that is not described.

3. **The admin UI "KnowledgeTab" described in Phase 4D is yet another tab.** Combined with Components, this brings the potential tab count to 8. Tab proliferation degrades the admin UX.

4. **From a product perspective, the Viking integration story is "install Viking as a component, then assistant tools become available."** This is clean and consistent with the component model. The problem is that there is no user-facing explanation of what Viking does or why you would install it. The component's README and description in the registry need to be written for a non-technical audience.

---

### #304 -- Brokered Admin-Authorized OpenCode Instance

**UX Impact:** High potential, but Phase 1 (foundations) is infrastructure, not user-facing. The user-facing value comes in Phase 2 (diagnostics) and Phase 3 (remediation), where the admin-side agent can help troubleshoot stack issues.

**Recommendation: KEEP Phase 1-2 for 0.10.0, DEFER Phase 3-4.**

Concerns:

1. **The user interaction model is undefined.** How does a user communicate with the admin-side agent? The issue describes API routes (`POST /admin/elevated/session/:id/message`) but does not describe the UI. Is there a chat window in the admin UI? Does the user type a question into a text field? Is it a separate page or a modal? For a feature designed to help users with diagnostics and configuration, the interaction surface is the most important design decision, and it is entirely missing.

2. **The assistant-to-admin-agent communication path is also undefined from a UX perspective.** The assistant can call admin API routes, but what does the user see when the assistant delegates to the admin agent? Transparency matters -- users should know when the assistant is "asking admin for help" versus doing something itself.

3. **The "on-demand" question (open question #2) should be answered: yes, on-demand.** Starting a second OpenCode process at boot time adds ~1GB memory to the admin container for a feature most users will not use on most requests. Start it when the user opens the diagnostics chat or when the assistant explicitly requests admin-level help.

---

### #302 -- TTS/STT Setup and Admin Interface

**UX Impact:** Voice input/output would be differentiating for a self-hosted AI assistant, but the issue has a two-sentence description with no plan document.

**Recommendation: DEFER to 0.11.0.**

Concerns:

1. **No scope definition.** "Add simple voice interface to setup wizard and admin UI" does not specify: which TTS engines (Kokoro, Piper, OpenAI TTS, browser Web Speech API)? Which STT engines (Whisper local, OpenAI STT, browser)? Where does the audio processing happen (client-side, server-side, sidecar container)? What is the latency budget?

2. **The setup wizard already has placeholder support** (the `SetupInput.voice` field exists with `tts?` and `stt?` strings), which suggests the backend contract is partially designed. But the admin UI work, audio pipeline, and engine integration are completely unscoped.

3. **This competes for setup wizard real estate.** The wizard is already gaining: components selection, optional encrypted secrets prompt, and channel credentials. Adding TTS/STT engine selection in the same release creates a wizard with too many steps for first-boot.

4. **Engine availability depends on components.** If Kokoro or Piper runs as a component (container), then TTS/STT setup depends on the component system being complete first. This creates a dependency chain: components (#301) must ship first, then TTS/STT engines become installable, then voice can be configured.

---

### #13 -- Advanced Channel Configuration Support

**UX Impact:** This issue predates the component system and describes features that are now largely subsumed by #301. Multi-instance channels, per-instance env vars, custom config UI, and clone/import/export are all addressed by the component model.

**Recommendation: CLOSE or MERGE into #301.**

Concerns:

1. **The issue references old code paths** (`admin/src/server.ts`, `gateway/entrypoint.sh`, `opencode-channel/entrypoint.sh`) that no longer exist in the current SvelteKit admin architecture. The code references are stale.

2. **Per-channel OpenCode configuration** (per-instance agent/tool/skill selection) is a genuinely useful feature not covered by #301. The component model gives each instance its own `.env`, but OpenCode config (which model, which tools) is a separate concern. This specific sub-feature should be extracted into a new issue.

3. **Custom config UI per channel** (channel developer serves an HTML config page) is an interesting idea but conflicts with the component plan's universal `.env.schema` form renderer. If every component can provide a custom config UI, the admin needs an iframe or micro-frontend pattern, which is significant complexity. Defer this to a future release.

---

### #315 -- Azure Container Apps Deployment with Key Vault Integration

**UX Impact:** Minimal for self-hosted users. High for enterprise/cloud users. The issue is well-scoped: a pure deployment-layer addition with no core code changes.

**Recommendation: KEEP, but isolate from the rest of 0.10.0.**

Concerns:

1. **The "Admin is not available" constraint is well-handled.** The issue correctly identifies that the Admin container is irrelevant in ACA and that the core message path (channel -> guardian -> assistant -> memory) operates independently. The deployment script replicates Admin's setup-time work.

2. **The component system (#301) is invisible to ACA deployments.** Components are managed by the Admin container via Docker Compose. ACA deployments use `az containerapp` instead. This means ACA users cannot install components. The issue handles this by documenting `./deploy-aca.sh add-channel` as the equivalent. But this creates a permanent fork in the management experience: self-hosted users get a component UI; cloud users get a shell script.

3. **Key Vault integration is a clean parallel to Varlock (#300).** Self-hosted users get `pass`; Azure users get Key Vault. The `SecretBackend` abstraction in #300 could theoretically support both -- adding an `AzureKeyVaultBackend` -- but this is over-engineering for 0.10.0. The deployment script approach is pragmatic and correct.

4. **This issue can ship independently of all other 0.10.0 work** since it touches no existing files. It should be developed in parallel and is not on the critical path.

---

## User Journey Analysis

### New User Onboarding (First Boot)

The current first-boot experience flows: open admin URL -> enter admin token -> see overview dashboard. There is no guided setup wizard in the admin UI today; the `performSetup()` function is called from the CLI or POST `/admin/connections` endpoints.

In 0.10.0, the first-boot experience gains significant new surface area:

1. **Admin token** (existing)
2. **LLM connection setup** (existing -- connections tab)
3. **Component selection** (new -- which optional components to enable?)
4. **Component configuration** (new -- `.env.schema` forms per selected component)
5. **Encrypted secrets opt-in** (new -- #300)
6. **TTS/STT engine selection** (new -- #302, if included)

**Risk:** This is too many steps for a user who just wants to chat with an AI. The setup wizard should have a "Quick Start" path that skips optional components, uses PlaintextBackend, and defers everything beyond LLM connection + admin token to post-setup configuration. The `SetupConfig` type already supports this (channels, services, and voice are all optional), but the UI needs to make the minimal path obvious.

**Recommendation:** The wizard should have exactly two required steps (admin token, LLM connection) and then land on the dashboard with a "Customize your stack" prompt card for optional components. Everything else is post-setup.

### Existing User Upgrade (0.9.x to 0.10.0)

This is the highest-risk user journey in the milestone. An existing user has:
- Legacy channels installed at `CONFIG_HOME/channels/*.yml`
- A `secrets.env` with API keys and admin token
- Running containers they depend on

After upgrading to 0.10.0:
1. Legacy channel definitions are **silently ignored** (no longer loaded by the staging pipeline).
2. Channels stop working.
3. User must figure out that they need to reinstall channels as components.

**This is unacceptable without in-product communication.** Release notes are not sufficient -- most self-hosted users upgrade by pulling new images and restarting, not by reading changelogs.

**Recommendation:** Add a migration detection step:
- On first startup after upgrade, scan `CONFIG_HOME/channels/` for `.yml` files.
- If found, display a banner in the admin UI: "Your channels from v0.9.x need to be reinstalled as components. [Learn how]"
- The CLI `openpalm update` command should print a migration notice.
- Do NOT silently drop channels. At minimum, log a warning at startup.

### Power User Workflows

Power users benefit significantly from 0.10.0:
- **Multi-instance channels:** Run two Discord bots with different configs. Clean.
- **Component catalog:** Drop a `compose.yml` + `.env.schema` directory into `DATA_HOME/catalog/` and it appears in the UI. No code changes. This is the file-drop promise delivered.
- **Encrypted secrets:** `pass` integration with GPG is exactly what security-conscious self-hosters want.
- **OpenViking:** Structured knowledge management for users who want the assistant to learn over time.
- **Artifacts tab + compose overlays:** Power users can inspect the assembled compose and understand what the component system is doing.

**Gap:** There is no `openpalm component add --from-dir ./my-component/` CLI command described. The CLI (`packages/cli/`) manages the stack but the component plan only describes admin API and UI flows. Power users who manage their stack via CLI need a component management CLI surface.

---

## Admin UI Coherence

The current admin UI has 6 tabs: Overview, Automations, Registry, Connections, Containers, Artifacts.

After 0.10.0 as planned, the potential tab landscape is:

| Tab | Source | Status |
|-----|--------|--------|
| Overview | Existing | Stays |
| Components | #301 | New -- replaces most of Containers + Registry |
| Extensions | Registry rewrite | Renamed from Registry -- now pulls from component registry |
| Connections | Existing | Stays, possibly refactored by #300 Phase 6 |
| Containers | Existing | Overlaps with Components -- should be removed or collapsed |
| Artifacts | Existing | Stays (power user) |
| Automations | Existing | Stays |
| Knowledge | #298 Phase 4D | New -- Q-value stats, knowledge health |
| Password Manager | #300 Phase 5 | New -- secrets list, rotation |
| Diagnostics / Admin Agent | #304 Phase 2 | New -- chat with admin-side agent |

That is 10 tabs, which is untenable. The tab bar already scrolls on mobile at 6 tabs.

**Recommendation for tab structure in 0.10.0:**

| Tab | What it contains |
|-----|-----------------|
| Overview | Stack health, quick actions, connection status |
| Components | Flat instance list (was Containers + Registry combined). Install from catalog, configure, start/stop, logs |
| Connections | LLM provider setup (existing) |
| Automations | Scheduled tasks (existing) |
| Artifacts | Compose + Caddyfile inspection (power user, existing) |

That is 5 tabs -- one fewer than today. Knowledge stats, password manager UI, and diagnostics chat should be deferred or accessible from within existing tabs (e.g., knowledge stats as a section in Overview, diagnostics as a button in the Overview health section).

---

## Documentation Needs

### Must-have for 0.10.0 release

1. **Upgrade guide from 0.9.x to 0.10.0** -- The clean break from legacy channels requires a step-by-step migration guide. This is the single most important document for the release.

2. **"Adding a Component" developer guide** (`docs/development/adding-a-component.md`) -- How to create a `compose.yml` + `.env.schema` + `.caddy` directory. This replaces the current channel development docs.

3. **Component `.env.schema` reference** -- Document the `@required`, `@sensitive`, `@default` annotations and how they render in the admin UI form. This is the API contract for component developers.

4. **Updated architecture diagram** -- The current diagram in CLAUDE.md shows CLI -> Docker Compose, Admin -> Docker Compose. The component system changes the composition model. The diagram needs to show component overlay assembly.

5. **Release notes with breaking changes prominently listed** -- Legacy channel removal, any API endpoint removals (gallery endpoints), and the component API surface.

### Should-have for 0.10.0 release

6. **Per-component documentation** for built-in components (Discord, Telegram, chat, API, Caddy, Ollama). Each should have a README in the component directory.

7. **Azure deployment guide** (`deploy/azure/README.md`) -- Already planned in #315.

8. **Secrets management guide** -- When to use PlaintextBackend vs `pass`, how GPG setup works, how to rotate secrets.

### Can defer

9. **OpenViking user guide** -- How to install the component, what it does, how to ingest resources.
10. **Eval framework documentation** -- Only relevant if eval ships in 0.10.0.
11. **Admin agent user guide** -- How to use the diagnostics chat.

---

## Recommendations

1. **UPDATE #301 (Components):** Add a tab consolidation plan to the components proposal. Define which existing tabs are replaced, merged, or removed. The Components tab should subsume Containers and the Extensions tab should subsume Registry. Target 5 tabs maximum.

2. **ADD: Migration detection for legacy channels.** On first startup after upgrade, detect `CONFIG_HOME/channels/*.yml` files and display a banner in the admin UI and a CLI warning. Do not silently drop channels without notification.

3. **DEFER #302 (TTS/STT) to 0.11.0.** The issue has no plan document, no scope definition, and competes for setup wizard real estate with #301 and #300. The `SetupInput.voice` backend support can remain as a forward-compatible stub.

4. **DEFER knowledge-system-roadmap Phases 3-4 (eval framework, MemRL Q-values) to a separate milestone.** Keep Phase 1A (Viking component directory) and Phase 1B (Viking assistant tools) in 0.10.0. These are the user-facing deliverables. The eval framework and Q-value scoring are internal infrastructure that can ship independently.

5. **CLOSE or MERGE #13 into #301.** The advanced channel configuration issue is superseded by the component system. Extract "per-instance OpenCode configuration" as a new, focused issue.

6. **UPDATE #300 (Password Manager):** Scope to Phases 0-4 for 0.10.0 (backend abstraction, `pass` provider, secrets API routes). Defer Phase 5 (Password Manager UI), Phase 6 (Connections refactor), and Phase 7 (Migration tooling) to 0.10.1. The component `.env.schema` `@sensitive` handling is the user-facing deliverable for secrets in 0.10.0.

7. **UPDATE #304 (Brokered Admin Instance):** Add a UI interaction design section. Define: where does the user chat with the admin agent? What does the interface look like? Is it a modal, a drawer, a separate page? Without this, the feature is backend infrastructure with no user-facing value in 0.10.0.

8. **ADD: "Quick Start" wizard path.** The setup wizard should have a minimal two-step path (admin token + LLM connection) that lands on the dashboard immediately. Component selection, encrypted secrets, and voice should all be accessible post-setup from a "Customize your stack" prompt on the Overview tab.

9. **ADD: CLI component management commands.** The component plan only describes admin API and UI flows. Add `openpalm component list`, `openpalm component add <name>`, `openpalm component configure <instance>`, and `openpalm component remove <instance>` to the CLI. Power users managing headless servers need this.

10. **UPDATE #315 (Azure):** Document the permanent divergence between self-hosted (component UI) and cloud (shell script) management paths. Consider whether a future "headless admin API" mode could bridge this gap -- not for 0.10.0, but as an architectural consideration.

11. **ADD: Write the upgrade guide before any code ships.** The upgrade guide should be drafted first to identify all user-facing breaking changes and inform the implementation of migration detection, deprecation warnings, and error messages. Writing it after the code ships is too late.

12. **UPDATE the component compose convention:** The `openpalm-` prefix on service names (`openpalm-${INSTANCE_ID}`) should be validated to ensure total service name length stays under Docker's 63-character limit. An instance named `my-very-long-custom-discord-bot-for-gaming-server` would produce a 62-character service name. Add a maximum instance ID length (e.g., 40 characters) to the validation in the create flow.

13. **ADD: Component health visibility on the Overview tab.** The current Overview tab shows Admin API and Guardian health. With the component system, users need at-a-glance health for all running component instances. Add a "Components" section to the Overview tab showing instance names and health status (green/yellow/red) based on the `openpalm.healthcheck` compose label.

14. **DEFER: The `KnowledgeTab` admin UI (from knowledge-system-roadmap Phase 4D) to the milestone that includes the eval framework.** Knowledge stats without the eval framework and Q-values are not actionable for users.

15. **UPDATE the unified registry plan:** Clarify what happens to the existing `registryInstall` and `registryUninstall` functions in the admin client code (`+page.svelte` lines 368-401). These currently work with `type: 'channel' | 'automation'`. The unified registry plan removes the type distinction for components but keeps automations separate. The client API needs a migration path for this type parameter change.

---

## Addendum: Filesystem & Mounts Refactor UX Review (2026-03-19)

### Summary

The `fs-mounts-refactor.md` proposal replaces the three-tier XDG layout (`~/.config/openpalm`, `~/.local/share/openpalm`, `~/.local/state/openpalm`) with a single `~/.openpalm/` root containing `config/`, `vault/`, `data/`, and `logs/`. It eliminates the staging tier in favor of validate-in-place with snapshot rollback, introduces hot-reload of LLM keys via a file watcher on `vault/user.env`, and adds an explicit `openpalm.yml` stack configuration file. This is a significant simplification of the mental model and daily operations, but it arrives in the same release as the legacy channel clean break and the component system rewrite, creating a triple-breaking-change upgrade.

### User Experience Assessment

**New users.** The proposed layout is unambiguously better for new users. A single `~/.openpalm/` directory with four clearly named subdirectories (`config/`, `vault/`, `data/`, `logs/`) maps directly to user intent: "where do I configure things," "where are my secrets," "where is my data," "where are the logs." The current XDG layout requires users to understand the distinction between `~/.config/openpalm`, `~/.local/share/openpalm`, and `~/.local/state/openpalm` -- three directories that most self-hosted users have never navigated to before. In onboarding friction terms, `cd ~/.openpalm && ls` is a one-step mental model; `find ~/.config/openpalm ~/.local/share/openpalm ~/.local/state/openpalm` is a three-step scavenger hunt.

**Existing users.** This is the pain point. Users who have running 0.9.x stacks must move from three XDG directories to `~/.openpalm/`. Combined with the legacy channel clean break (reinstall channels as components) and the env file restructuring (single `secrets.env` becomes `vault/user.env` + `vault/system.env`), the upgrade requires touching every operational assumption the user has built. This is manageable only if the CLI provides an automated migration command.

**Power users.** Power users who have scripts, aliases, or automation referencing XDG paths will need to update them. However, power users will also immediately appreciate the consolidation -- shell completion on `~/.openpalm/` is faster than navigating three XDG trees, and the explicit `openpalm.yml` gives them a single file to understand what their stack does. The `vault/` separation is intuitive for anyone with security awareness: secrets in one place, config in another, with clear mount boundaries.

### Hot-Reload UX

This is the single highest-impact UX improvement in the proposal. The current workflow for adding or rotating an LLM API key is:

1. Edit `~/.config/openpalm/secrets.env`
2. Run `openpalm apply` (or equivalent admin action)
3. Wait for staging to copy the file
4. Wait for container restart
5. Lose any in-progress assistant conversation context

The proposed workflow is:

1. Edit `~/.openpalm/vault/user.env`
2. Done. The assistant picks it up in seconds. No restart. No lost context.

This eliminates the most common friction point in daily operation. Users who rotate API keys, switch providers, or experiment with different LLM services will go from a multi-step process with downtime to an instantaneous change. The file watcher implementation in the proposal (Section 3.3) is straightforward and uses an explicit allowlist of keys (`ALLOWED_KEYS`), which is the correct safety approach -- it prevents a malicious or accidental environment variable from being injected through the user.env file.

**Concern:** The hot-reload only works for the assistant. The memory service also uses LLM keys (`OPENAI_API_KEY`, `OPENAI_BASE_URL`) but receives them via `${VAR}` substitution at container creation time. If a user changes their embedding provider key in `user.env`, the assistant picks it up immediately but the memory service still has the old key until its container is recreated. The proposal should document this asymmetry clearly: "LLM keys for the assistant reload instantly. Keys used by the memory service require `openpalm apply` to take effect." Otherwise users will expect uniform hot-reload and be confused when memory operations fail after a key rotation.

### Backup & Restore UX

The backup simplification is significant and well-designed. Current backup requires understanding which directories matter:

```bash
# Current: which of these three do I need? All of them? Just config + data?
tar czf backup.tar.gz ~/.config/openpalm ~/.local/share/openpalm
# (and maybe ~/.local/state/openpalm for logs?)
```

Proposed:

```bash
tar czf backup.tar.gz ~/.openpalm
```

One directory, one command, complete backup. The intentional exclusion of `~/.cache/openpalm/` (rollback snapshots, registry cache) from the backup target is correct -- cache data is regenerable and would bloat backups unnecessarily.

The restore story is equally improved. The current restore requires the admin to regenerate STATE_HOME from CONFIG + DATA, which means a `tar extract` is not sufficient -- you must also run an apply step. The proposed restore is extract-and-start: the compose files and env files are live in their final locations.

**One gap:** The proposal does not address partial restore. If a user wants to restore only their secrets (because they accidentally deleted `user.env`), they need to extract a single file from the tar archive. This is a standard tar operation (`tar xzf backup.tar.gz .openpalm/vault/user.env`) but should be documented as a common recovery scenario.

### Upgrade Path

This is the highest-risk aspect of the proposal. The 0.9.x to 0.10.0 upgrade now involves:

1. **Directory migration:** Three XDG trees to `~/.openpalm/`
2. **Env file split:** Single `secrets.env` becomes `vault/user.env` + `vault/system.env`
3. **Staging elimination:** `STATE_HOME/artifacts/` no longer exists
4. **Channel migration:** Legacy `channels/*.yml` replaced by `config/components/*.yml`
5. **Stack config:** No equivalent of `openpalm.yml` exists today

That is five simultaneous structural changes. Any one of them alone would be a reasonable upgrade task. Together, they demand an automated migration tool. The proposal does not describe one.

**Minimum viable migration:** The CLI `openpalm update` command must detect the old XDG layout and offer to migrate:

1. Detect `~/.config/openpalm/secrets.env` exists
2. Parse it, split user-facing keys into `vault/user.env` and system keys into `vault/system.env`
3. Move `~/.config/openpalm/channels/` contents to `~/.openpalm/config/components/`
4. Move `~/.local/share/openpalm/*/` data directories to `~/.openpalm/data/*/`
5. Generate a default `openpalm.yml` based on currently enabled services
6. Print a summary of what moved where
7. Offer to keep the old directories as a backup (rename to `~/.config/openpalm.bak`)

Without this, the upgrade is a manual file-reorganization exercise that will lose users. My original review (Recommendation #2) called for migration detection with a banner; with the filesystem refactor added, detection is insufficient -- automated migration is required.

### Documentation Impact

The documentation rewrite scope is substantial. Every reference to the XDG layout must be updated:

| Document | Impact |
|----------|--------|
| `docs/technical/authoritative/core-principles.md` | **Full rewrite** of Sections 1-3 (filesystem contract). The three-tier model, tier boundaries, and volume-mount contract all change. |
| `CLAUDE.md` | **Full rewrite** of XDG Directory Model table, Architecture Rules summary, Key Files paths |
| `packages/lib/src/control-plane/paths.ts` | **Code rewrite** -- `resolveConfigHome()`, `resolveDataHome()`, `resolveStateHome()` all change, `ensureXdgDirs()` creates different directories |
| `packages/lib/src/control-plane/staging.ts` | **Major refactor or removal** -- staging pipeline is eliminated; validation-in-place and rollback replace it |
| `packages/cli/src/lib/staging.ts` | **Rewrite** -- CLI staging helpers reference STATE_HOME |
| `assets/docker-compose.yml` | **Rewrite** -- all bind mount paths change |
| All test files referencing XDG paths | **Update** -- 12+ files in `packages/lib/src/control-plane/` reference the three-tier model |
| Any user-facing documentation or README | **Update** -- backup instructions, configuration instructions, troubleshooting guides |

This is not a cosmetic update. The filesystem contract is the foundational abstraction of the project. Changing it touches every layer: documentation, library code, CLI, admin, compose files, and tests. The documentation must be updated atomically with the code -- shipping the code change without updated docs would leave users with incorrect instructions.

### Naming Assessment

**`vault/` as a name.** "Vault" is a strong, intuitive name for a secrets directory. It immediately signals "sensitive content, handle with care." The only risk is confusion with HashiCorp Vault, but in context (a directory on disk, not a networked service) the meaning is clear. It is better than alternatives like `secrets/` (too generic, easily confused with Docker secrets or Kubernetes secrets) or `env/` (conflates env files with secrets).

**`user.env` / `system.env` split.** The naming is clear. "User" means "you edit this." "System" means "the system manages this, hands off." The split maps to the access control model: user.env is mounted read-only into the assistant; system.env is never mounted except by admin. The names reinforce the boundary.

**`openpalm.yml` as the stack config file.** Good name. It matches the project name, is discoverable (`ls ~/.openpalm/config/` immediately shows it), and the `.yml` extension signals human-editable YAML. It is better than the current implicit model where "which compose files exist in the channels directory" determines the stack configuration.

### `openpalm.yml` Discoverability

The explicit stack config file is a significant UX improvement over the current implicit model. Today, understanding what a stack does requires:

1. List `CONFIG_HOME/channels/` to see which channels are installed
2. Read `DATA_HOME/stack.env` to see which optional services are enabled (`OP_OLLAMA_ENABLED`, `OP_ADMIN_ENABLED`)
3. Inspect `STATE_HOME/artifacts/` to see what was actually staged

With `openpalm.yml`, the answer is in one file:

```yaml
components:
  admin: true
  ollama: false
```

This is immediately readable and editable. It replaces scattered boolean flags in `stack.env` with a structured, human-friendly configuration. The `features:` and `network:` sections further consolidate settings that are currently spread across environment variables.

**Concern:** The proposal shows `openpalm.yml` in `config/` but does not specify what happens when `openpalm.yml` and the contents of `config/components/` disagree. If `openpalm.yml` says `ollama: false` but `config/components/ollama.yml` exists, which wins? The proposal should define precedence: `openpalm.yml` is authoritative, and a component overlay in `config/components/` is only included in the compose invocation if `openpalm.yml` enables it (or if it's not listed in `openpalm.yml`, in which case presence in `components/` implies enabled). This needs to be unambiguous.

### Rollback UX

`openpalm rollback` as a first-class command is excellent. The current system has no rollback mechanism at all -- if a staged apply breaks the stack, the user must manually debug compose files and env variables. The proposed flow (validate -> snapshot -> write -> deploy -> auto-rollback on failure) provides a safety net that makes configuration changes lower-risk.

**Concern:** The rollback snapshot lives in `~/.cache/openpalm/rollback/` and holds only the most recent previous state. This means:

1. If two consecutive applies fail, the rollback target is the state before the first apply, which is correct.
2. But if a user runs `apply`, it succeeds, then they realize hours later the change was wrong, the rollback snapshot has already been overwritten by the successful apply's pre-snapshot. There is no "undo the last successful apply" -- only "undo the last failed apply."

The proposal should clarify this limitation. For deeper history, consider keeping the last N snapshots (e.g., 3) with timestamps, and letting `openpalm rollback` accept an optional `--to <timestamp>` flag. This is a minor enhancement that significantly improves the safety story.

### Interaction with Review Decisions

The `review-decisions.md` document (Q2) explicitly states: **"Preserve the three-tier XDG model."** The filesystem refactor proposal directly contradicts this decision by collapsing three XDG roots into `~/.openpalm/`. This contradiction must be resolved before implementation. Either the review decision is updated to reflect the new direction, or the refactor proposal must be revised to preserve XDG compliance (e.g., `~/.config/openpalm/` for config, `~/.local/share/openpalm/` for data, but eliminate STATE_HOME and add vault/).

The proposal is the better design, but the decision log must be amended to document why the earlier decision was reversed and what new information justified the change.

### Recommendations

16. **ADD: Automated migration tool for XDG-to-`~/.openpalm/` transition.** The CLI `openpalm update` command must detect the old three-directory XDG layout and perform an automated migration: split `secrets.env` into `vault/user.env` + `vault/system.env`, move channel overlays to `config/components/`, relocate data directories, generate a default `openpalm.yml`, and offer to keep old directories as `.bak` backups. Manual migration for five simultaneous structural changes is unacceptable.

17. **UPDATE: Resolve the contradiction with review-decisions.md Q2.** The decision log says "preserve the three-tier XDG model." The filesystem refactor eliminates it. Amend the Q2 decision with rationale for why the single-root model supersedes the earlier decision, or revise the refactor to preserve XDG compliance in some form.

18. **UPDATE: Document the hot-reload asymmetry.** The assistant picks up `user.env` changes instantly, but the memory service (and any other container receiving keys via `${VAR}` substitution) does not. Document clearly which services hot-reload and which require `openpalm apply` after a key change. Consider adding a CLI convenience command: `openpalm reload-keys` that recreates only the containers that need updated env vars (memory, guardian) without touching the assistant.

19. **UPDATE: Define `openpalm.yml` vs `config/components/` precedence.** Specify what happens when the stack config file and the component overlay directory disagree (e.g., `ollama: false` in YAML but `ollama.yml` exists on disk). Recommendation: `openpalm.yml` is authoritative; component overlays are only included when enabled in the YAML file.

20. **UPDATE: Expand rollback to retain multiple snapshots.** The single-snapshot rollback only protects against failed applies, not regretted successful applies. Keep the last 3 snapshots with timestamps in `~/.cache/openpalm/rollback/` and add `openpalm rollback --list` and `openpalm rollback --to <timestamp>` for deeper undo capability.

21. **ADD: Document partial restore procedures.** The one-tar backup is a strong improvement, but users need documented procedures for common partial-restore scenarios: recovering just secrets (`vault/user.env`), recovering just a specific service's data (`data/memory/`), or recovering configuration without overwriting current data.

22. **DEFER: Ship the filesystem refactor and the component system in separate minor releases if possible.** Two breaking structural changes in one release (directory layout + component system) compounds upgrade risk. Ideally: 0.10.0 ships the component system with the existing XDG layout, 0.11.0 ships the filesystem consolidation. If they must ship together, the automated migration tool (Recommendation #16) is non-negotiable.

23. **UPDATE: Clarify the `~/.cache/openpalm/` relationship to `~/.openpalm/`.** The proposal splits state between two root paths (`~/.openpalm/` and `~/.cache/openpalm/`). This partially undermines the "single root" simplification. Consider whether rollback snapshots and registry cache could live under `~/.openpalm/.cache/` instead -- still excluded from backups via documentation convention, but discoverable under the single root. The XDG cache convention is technically correct but reintroduces the "where is my OpenPalm stuff?" scavenger hunt for the cache portion.

24. **ADD: Include `openpalm doctor` or `openpalm status` command output in the proposal.** A single-root layout enables a clean status command that reports on all four subdirectories: config file count, vault health (schemas match, no empty required keys), data directory sizes, log file sizes. This would be a natural complement to the simplified layout and a strong onboarding tool.
