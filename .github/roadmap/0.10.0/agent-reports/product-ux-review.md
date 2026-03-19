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
