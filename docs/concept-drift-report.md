# Concept Drift Report

> **Historical Snapshot (2026-02-19):** This report was generated before the alignment fixes on this branch were applied. Many issues listed below have since been resolved. See `docs/ux-cohesion-review.md` for current status.

Source of truth: `docs/admin-concepts.md` (technical) and `docs/user-concepts.md` (user-facing).

22 project documentation files were reviewed against the five canonical concepts (Extensions, Connections, Channels, Automations, Gateway). This report lists every instance where documentation drifts from, contradicts, or is incomplete relative to the source of truth.

---

## HIGH Severity Issues

These are direct contradictions or critical omissions that will cause confusion if left unfixed.

| # | File | Issue |
|---|------|-------|
| 1 | `README.md` | Extensions definition includes "container services" (not an extension type) and omits commands, agents, custom tools |
| 2 | `docs/architecture.md` | Connections concept entirely absent |
| 3 | `docs/architecture.md` | Automations concept entirely absent (maintenance cron documented, user Automations are not) |
| 4 | `docs/architecture.md` | Directory names use singular `tool/` and `command/` instead of plural `tools/` and `commands/` |
| 5 | `docs/extensions-analysis.md` | "Extensions" umbrella term never established; sub-types exposed directly as top-level concepts |
| 6 | `docs/extensions-analysis.md` | `tool/` (singular) used instead of `tools/` (plural) throughout |
| 7 | `docs/extensions-analysis.md` | `command/` (singular) used instead of `commands/` (plural) throughout |
| 8 | `docs/extensions-reference.md` | Only 3 of 5 extension sub-types defined (Skills, Plugins, Containers); Commands, Agents, Custom Tools missing |
| 9 | `docs/extensions-reference.md` | "Containers" listed as an extension category -- not a defined extension type |
| 10 | `docs/extensions-reference.md` | `tool/` (singular) used instead of `tools/` (plural) |
| 11 | `docs/extensions-reference.md` | `command/` (singular) used instead of `commands/` (plural) |
| 12 | `docs/extensions-reference.md` | Risk levels use a generic 4-tier scale (low/medium/high/critical) not tied to extension type |
| 13 | `docs/extensions-guide.md` | Title equates Extensions with Plugins only: "(OpenCode Plugins)" |
| 14 | `docs/extensions-guide.md` | `plugin[]` described as "the canonical extension registry" -- excludes skills, commands, agents, tools |
| 15 | `docs/extensions-guide.md` | Gallery/authoring framing omits Commands, Agents, Custom Tools entirely |
| 16 | `docs/api-reference.md` | Gallery API category filter uses `container` -- not a defined extension type |
| 17 | `docs/api-reference.md` | "Cron jobs" used throughout instead of canonical term "Automations" |
| 18 | `docs/host-system-reference.md` | Extension plural subdirectory convention (skills/, commands/, agents/, tools/, plugins/) not documented |
| 19 | `docs/host-system-reference.md` | `cron/` directory name conflicts with source of truth's `cron-payloads/`; "Cron job definitions" used instead of "Automations" |
| 20 | `docs/testing-plan.md` | Connections concept has zero test coverage -- not mentioned anywhere |
| 21 | `docs/checklist.md` | Connections concept entirely absent from implementation checklist |
| 22 | `docs/checklist.md` | Extension sub-types listed as "plugins, skills, agents, lib" -- missing Command and Custom Tool; includes non-canonical "lib" |
| 23 | `docs/checklist.md` | "Removed CONFIG directory" potentially conflicts with OPENCODE_CONFIG_DIR as canonical Extensions location |
| 24 | `docs/discrepancy-report.md` | Connections concept absent from gap analysis entirely |
| 25 | `assets/state/registry/README.md` | Schema `category` field only has `plugin`, `skill`, `container` -- missing command, agent, tool |
| 26 | `assets/state/registry/README.md` | `installAction` enum missing extension types for commands, agents, custom tools |
| 27 | `assets/state/registry/README.md` | Risk level scale (low/medium/high/critical) does not match type-based risk hierarchy (lowest/low/medium/medium-high/highest) |
| 28 | `gateway/opencode/skills/channel-intake/SKILL.md` | channel-intake is defined as a Skill; source of truth defines it as an Agent |
| 29 | `gateway/opencode/skills/channel-intake/SKILL.md` | `denied-tools` list is weaker than "zero tool access" -- only denies 4 named tools |
| 30 | `docs/implementation-guide.md` | Build order step 3 says "Connect OpenMemory via MCP" but Section 3 of the same file says "no MCP in the runtime path" (internal contradiction) |

---

## MEDIUM Severity Issues

Outdated, incomplete, or inconsistent terminology that should be updated.

| # | File | Issue |
|---|------|-------|
| 31 | `README.md` | Discovery sources omit "community registry" (lists only gallery and npm) |
| 32 | `README.md` | "Scheduled tasks" / "recurring jobs" used instead of canonical "Automations" |
| 33 | `AGENTS.md` | "extensions and skills" listed as parallel concepts, breaking the umbrella definition |
| 34 | `AGENTS.md` | Five core concepts (Extensions, Connections, Channels, Automations, Gateway) never defined for AI agent guidance |
| 35 | `docs/architecture.md` | "lib" listed as an extension type; Commands and Custom Tools omitted |
| 36 | `docs/architecture.md` | Gateway pipeline missing "payload validation" as a distinct step |
| 37 | `docs/architecture.md` | Gateway endpoint `/channel/inbound` not documented |
| 38 | `docs/admin-guide.md` | "Edit agent config" exposes agent sub-type in user-facing protected actions list |
| 39 | `docs/admin-guide.md` | Automations concept entirely absent |
| 40 | `docs/admin-guide.md` | Connections concept entirely absent |
| 41 | `docs/admin-guide.md` | `OPENPALM_CONFIG_HOME` used without explaining relationship to `OPENCODE_CONFIG_DIR` |
| 42 | `docs/implementation-guide.md` | Subtitle enumerates sub-types (plugins/tools/skills) instead of "Extensions" umbrella |
| 43 | `docs/implementation-guide.md` | "OpenCode plugins" used as component name instead of "Extensions" |
| 44 | `docs/implementation-guide.md` | Channels used without naming or defining the Channels concept |
| 45 | `docs/implementation-guide.md` | Custom Tools discussed outside the Extensions risk hierarchy |
| 46 | `docs/implementation-guide.md` | Automations concept entirely absent |
| 47 | `docs/implementation-guide.md` | Connections concept entirely absent |
| 48 | `docs/docker-compose-guide.md` | "lib" used as implied extension sub-type (not a defined type) |
| 49 | `docs/docker-compose-guide.md` | Channel env file path in `assets/config/` inconsistent with admin-guide XDG layout |
| 50 | `docs/docker-compose-guide.md` | Automations concept entirely absent |
| 51 | `docs/docker-compose-guide.md` | Connections concept entirely absent |
| 52 | `docs/extensions-analysis.md` | Risk levels by extension type not documented |
| 53 | `docs/extensions-reference.md` | Connections term and admin API model absent |
| 54 | `docs/extensions-reference.md` | Automations concept absent |
| 55 | `docs/extensions-reference.md` | Gateway pipeline incomplete; 120/min rate not specified |
| 56 | `docs/extensions-guide.md` | Skill scaffold example uses flat `CalendarOps.SKILL.md` instead of `skills/<name>/SKILL.md` directory |
| 57 | `docs/extensions-guide.md` | Connections term absent |
| 58 | `docs/extensions-guide.md` | Automations concept absent |
| 59 | `docs/extensions-guide.md` | Channels framed as "stack add-ons" rather than a first-class concept |
| 60 | `docs/security.md` | Gateway pipeline split across two sections; payload validation step missing |
| 61 | `docs/api-reference.md` | Rate-limiting step omitted from Gateway processing pipeline |
| 62 | `docs/api-reference.md` | `GET /admin/installed` lists "loaded skills" as separate from "extensions" |
| 63 | `docs/api-reference.md` | Channel env file naming (`discord.env`) differs from source of truth example (`channel-discord.env`) |
| 64 | `docs/host-system-reference.md` | `OPENCODE_CONFIG_DIR` variable not mentioned in Extensions section |
| 65 | `docs/host-system-reference.md` | Connections concept absent; `OPENPALM_CONN_*` prefix and `{env:VAR_NAME}` interpolation unmentioned |
| 66 | `docs/host-system-reference.md` | Channel env file naming (`channels/discord.env`) differs from source of truth (`channel-discord.env`) |
| 67 | `docs/testing-plan.md` | Section 5f titled "Cron Jobs Page" instead of "Automations" |
| 68 | `docs/testing-plan.md` | Gallery category filter only names "Plugins", ignoring other extension types |
| 69 | `docs/testing-plan.md` | Installed Extensions page described as "Lists active plugins" (not all types) |
| 70 | `docs/checklist.md` | `plugin[]` described as "canonical extension registry" -- excludes non-plugin types |
| 71 | `docs/checklist.md` | "Automations" never named; only "cron-store" used |
| 72 | `docs/discrepancy-report.md` | Conflates infrastructure maintenance cron (controller) with user Automations (opencode-core) |
| 73 | `docs/discrepancy-report.md` | "Cron job" used as concept name instead of "Automations" |
| 74 | `CONTRIBUTING.md` | Channel env file naming: `channels/discord.env` vs canonical `channel-discord.env` |
| 75 | `gateway/opencode/agents/channel-intake.md` | Uses "agent team" instead of "assistant"; memory recall step not in canonical pipeline |
| 76 | `opencode/extensions/command/memory-recall.md` | Singular `command/` directory violates plural `commands/` convention |
| 77 | `opencode/extensions/command/memory-save.md` | Singular `command/` directory violates plural `commands/` convention |
| 78 | `opencode/extensions/command/health.md` | Singular `command/` directory violates plural `commands/` convention |
| 79 | `assets/state/registry/README.md` | `container` used as category value but is not an Extension type (it maps to Channels) |
| 80 | `assets/state/registry/README.md` | Example shows plugin with `"risk": "low"` but Plugin is the highest-risk type |

---

## Cross-Cutting Patterns

### 1. "Connections" is the most pervasively absent concept
None of the reviewed files meaningfully reference the Connections concept by name. Files that mention `secrets.env` do so without connecting it to the Connections abstraction layer. Affected: architecture.md, admin-guide.md, implementation-guide.md, docker-compose-guide.md, extensions-reference.md, extensions-guide.md, host-system-reference.md, testing-plan.md, checklist.md, discrepancy-report.md.

### 2. "Automations" is consistently called "cron jobs"
Every file that discusses scheduled tasks uses "cron jobs", "crons", or "cron-store" as the concept name. The canonical term "Automations" appears in zero files outside the concept documents themselves. Affected: README.md, api-reference.md, testing-plan.md, checklist.md, discrepancy-report.md, host-system-reference.md.

### 3. "Extensions" umbrella term is undermined by sub-type exposure
Multiple documents list sub-types (plugins, skills, lib) as peer-level concepts rather than sub-types of Extensions. "lib" appears as a pseudo-extension-type in several files but is not a defined type. Affected: README.md, AGENTS.md, architecture.md, extensions-analysis.md, extensions-reference.md, extensions-guide.md, checklist.md, docker-compose-guide.md.

### 4. "Containers" treated as an extension type
The gallery schema, API, and multiple docs treat "container" as a category alongside "plugin" and "skill". The source of truth does not define containers as an extension type -- Channels are a separate top-level concept. Affected: assets/state/registry/README.md, api-reference.md, extensions-reference.md, extensions-guide.md.

### 5. Singular directory names persist
The codebase and documentation still use `command/` and `tool/` (singular) despite the source of truth specifying plural (`commands/`, `tools/`). Affected: architecture.md, extensions-analysis.md, extensions-reference.md, and the actual extension files in `opencode/extensions/command/`.

### 6. Gateway pipeline described inconsistently
The 6-step pipeline (HMAC verification, payload validation, rate limiting, intake validation, forward, audit log) is never fully enumerated in any doc outside the concept documents. Steps are omitted, reordered, or split across sections. Affected: architecture.md, security.md, api-reference.md, extensions-reference.md.

---

## Files Reviewed

| File | HIGH | MEDIUM | LOW |
|------|------|--------|-----|
| `README.md` | 1 | 2 | 1 |
| `CONTRIBUTING.md` | 0 | 1 | 2 |
| `AGENTS.md` | 0 | 2 | 2 |
| `docs/architecture.md` | 3 | 3 | 1 |
| `docs/admin-guide.md` | 0 | 4 | 3 |
| `docs/implementation-guide.md` | 1 | 6 | 2 |
| `docs/docker-compose-guide.md` | 0 | 4 | 2 |
| `docs/extensions-analysis.md` | 3 | 2 | 4 |
| `docs/extensions-reference.md` | 5 | 3 | 2 |
| `docs/extensions-guide.md` | 3 | 4 | 3 |
| `docs/security.md` | 0 | 1 | 3 |
| `docs/api-reference.md` | 2 | 3 | 1 |
| `docs/host-system-reference.md` | 2 | 3 | 0 |
| `docs/testing-dispatch.md` | 0 | 0 | 2 |
| `docs/testing-plan.md` | 1 | 3 | 1 |
| `docs/checklist.md` | 3 | 3 | 1 |
| `docs/discrepancy-report.md` | 1 | 2 | 0 |
| `assets/state/registry/README.md` | 3 | 2 | 1 |
| `gateway/opencode/agents/channel-intake.md` | 0 | 1 | 2 |
| `gateway/opencode/skills/channel-intake/SKILL.md` | 2 | 1 | 1 |
| `opencode/extensions/AGENTS.md` | 0 | 0 | 1 |
| `gateway/opencode/AGENTS.md` | 0 | 0 | 1 |
| `opencode/extensions/skills/memory/SKILL.md` | 0 | 0 | 2 |
| `opencode/extensions/command/memory-recall.md` | 0 | 1 | 1 |
| `opencode/extensions/command/memory-save.md` | 0 | 1 | 1 |
| `opencode/extensions/command/health.md` | 0 | 1 | 1 |
| **TOTALS** | **30** | **52** | **42** |

---

## Recommended Fix Priority

1. **Registry schema** (`assets/state/registry/README.md`) -- Add all 5 extension types, fix risk scale, remove `container` as extension category
2. **Extensions docs** (`extensions-reference.md`, `extensions-guide.md`, `extensions-analysis.md`) -- Establish umbrella term, add missing types, fix directory names
3. **API reference** (`api-reference.md`) -- Rename "Cron jobs" to "Automations", fix gallery categories
4. **Architecture doc** (`architecture.md`) -- Add Connections and Automations sections, fix directory names
5. **Admin guide** (`admin-guide.md`) -- Add Connections and Automations sections
6. **channel-intake identity** (`gateway/opencode/skills/channel-intake/SKILL.md`) -- Resolve skill-vs-agent conflict, fix tool denial to deny-all
7. **Directory rename** -- Move `command/` to `commands/`, `tool/` to `tools/` across codebase
8. **Global search-and-replace** -- "cron jobs" to "Automations" across all docs
9. **Remaining docs** -- Add Connections concept references where credentials are discussed
