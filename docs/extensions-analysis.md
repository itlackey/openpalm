# OpenPalm Extensions: Critical Analysis and Recommendations

> **Related extension docs:**
> - [extensions-guide.md](extensions-guide.md) -- How to build and install extensions (developer tutorial)
> - [extensions-reference.md](extensions-reference.md) -- Technical reference for all extension types (API/schema details)
> - **extensions-analysis.md** (this file) -- Architecture analysis of the extension system (design rationale)

This document is a technical review of how OpenPalm implements its extension system, evaluated against the capabilities of the OpenCode runtime it depends on. It identifies gaps, structural issues, and concrete recommendations for improvement. It has been updated to reflect recent repository changes.

## Extension System Overview

**Extension** is the umbrella term for all modular components that add behavior or capability to the OpenPalm stack. There are five sub-types, each with a distinct risk level:

| Sub-type | Risk | Directory | Description |
|---|---|---|---|
| Skill | lowest | `skills/<name>/SKILL.md` | Markdown behavioral directive injected into prompt context |
| Command | low | `commands/<name>.md` | Slash command definition |
| Agent | medium | `agents/<name>.md` | Specialized assistant persona |
| Custom Tool | medium-high | `tools/<name>.ts` | TypeScript LLM-callable function |
| Plugin | highest | `plugins/<name>.ts` | TypeScript lifecycle hooks |

OpenCode auto-discovers each sub-type from its respective subdirectory under `OPENCODE_CONFIG_DIR`. The `plugin[]` array in `opencode.jsonc` is specifically for registering Plugin-type extensions and npm packages; it does not cover Skills, Commands, Agents, or Custom Tools.

> **Note on `lib/`:** The `lib/` directory is a shared library directory, not an extension sub-type. Files in `lib/` (e.g., `openmemory-client.ts`) are imported by plugins and tools as internal utilities and are not auto-discovered by OpenCode.

> **Note on Channels:** Channel adapters (Discord, Telegram, Voice, Web Chat) run as dedicated container services. Channels are a **separate top-level concept** — not an Extension sub-type. References to "container extensions" in earlier versions of this document were incorrect; channels are managed as Docker Compose services, not via `opencode.jsonc`.

## Status

All recommendations (R1–R12) from this analysis have been addressed. See the
git history for implementation details.

| Rec | Status | Summary |
|-----|--------|---------|
| R1  | Done   | YAML frontmatter added to all SKILL.md files |
| R2  | Done   | Phantom gallery entries removed, skill-memory added |
| R3  | Done   | Admin allowlist made dynamic via OPENPALM_EXTRA_SERVICES |
| R4  | Done   | Plugins moved to plugins/ auto-discovery path |
| R5  | Done   | MCP disabled in opencode.jsonc |
| R6  | Done   | Entrypoint config layering fixed with cp -rn merge |
| R7  | Done   | Plugin type signatures adopted |
| R8  | Done   | Custom tools created in tools/ directory |
| R9  | Done   | Model and provider config added |
| R10 | Done   | extensionManifest documentation removed |
| R11 | Done   | Channel-intake agent moved to agent/ markdown file |
| R12 | Done   | Slash commands created in commands/ directory |

---

## Changes Since Last Review

Several recommendations from the initial analysis have been partially or fully addressed:

**Addressed: Skills restructured toward OpenCode's directory pattern.** Skills (the lowest-risk extension sub-type) now follow the `skills/<name>/SKILL.md` directory structure (`skills/memory/SKILL.md`, `skills/channel-intake/SKILL.md`). The flat `SkillName.SKILL.md` layout is gone. The `RecallFirst` and `MemoryPolicy` skills were consolidated into a single `memory/SKILL.md`. The `ActionGating` skill was merged into the gateway's `AGENTS.md`.

**Addressed: Gateway config clarity.** The gateway's `opencode.jsonc` now uses wildcard permission denial (`"*": "deny"`), wildcard tool disabling (`"*": false`), and explicitly loads `AGENTS.md` via the `instructions` array. The gateway's config is fully baked into its image with no host volume mount, eliminating the ambiguity about whether it was used.

**Addressed: Extensions baked into images.** Extensions moved from the host-seeded `assets/opencode/` model to being COPY'd into container images at build time from `opencode/extensions/` and `gateway/opencode/`. The host config directory now serves as an override layer rather than the primary extension source. This simplifies the upgrade path — new extensions are delivered via image updates rather than requiring installer re-runs.

**Addressed: `instructions` configuration.** The gateway's `opencode.jsonc` now includes `"instructions": ["AGENTS.md"]`, making AGENTS.md loading explicit.

**Addressed: Repository restructuring.** The `assets/` directory was reorganized into `assets/config/` and `assets/state/`, with extension source code moved to `opencode/extensions/` and `gateway/opencode/`. The registry moved to `assets/state/registry/`. Scripts moved to `assets/state/scripts/`. Channel env files were renamed from `channel-*.env` to just `*.env` under `channels/`.

---

## What Works Well

**Baked-in with host override.** The new architecture bakes extensions into images at build time while allowing host-side overrides via volume mount. This is a significant improvement: it provides a clean upgrade path (pull new image, restart), works out of the box without the installer seeding extensions, and still allows operators to customize without rebuilding.

**Entrypoint fallback logic.** The `opencode-core` entrypoint copies baked-in defaults to `/config` when the host mount is empty. This means the container always works, whether the operator mounts a volume or not.

**Gateway lockdown.** Wildcard denials (`"*": "deny"` for permissions, `"*": false` for tools) in the gateway config are cleaner and more robust than listing individual tools to disable. The 6-step Gateway pipeline (HMAC verification, payload validation, rate limiting at 120 req/min per user, intake validation via restricted agent with zero tool access, forward to assistant, audit log) provides layered security.

**Consolidated memory skill.** Merging `RecallFirst` and `MemoryPolicy` into a single `memory/SKILL.md` (a Skill-type extension) reduces skill sprawl and keeps related behavioral rules together.

**Atomic config updates with backups.** The `updatePluginListAtomically()` pattern with temp-file-then-rename and timestamped backups remains solid.

**Config policy lint.** The admin config editor still rejects permission widening, which is a good guardrail.

**Connections management.** Named credential sets (AI Provider, Platform, API Service types) are stored in `secrets.env` and managed via the admin API. This keeps credentials out of extension files and container images.

---

## Resolved Issues (Details)

The following issues were identified during the initial analysis and have all been resolved. Details are preserved here for historical context.

### 1. Skills YAML Frontmatter (R1) — RESOLVED
Skills (lowest-risk extension sub-type) now include YAML frontmatter with `name`, `description`, and `denied-tools` fields, enabling OpenCode auto-discovery and per-skill permission scoping.

### 2. Plugin Location (R2, R4) — RESOLVED
Plugins (highest-risk extension sub-type) moved from `skills/memory/scripts/` to `opencode/extensions/plugins/`, the standard auto-discovery path. They are also explicitly registered in the `plugin[]` array in `opencode.jsonc`.

### 3. Plugin Type Signatures (R7) — RESOLVED
Plugins now define local `Plugin` types. Two patterns are used: with context parameter (`PluginContext`) for plugins needing the OpenCode client, and without for standalone plugins. Both return event-hook handler objects.

### 4. Phantom Gallery Entries (R2) — RESOLVED
Non-existent gallery entries have been removed. The `skill-memory` entry was added for the consolidated memory Skill-type extension.

### 5. Admin Dynamic Allowlist (R3) — RESOLVED
The admin now reads `OPENPALM_EXTRA_SERVICES` from the environment, allowing community channel services and other compose services to be managed without code changes.

### 6. MCP Disabled (R5) — RESOLVED
MCP is explicitly disabled in `opencode.jsonc` (`"enabled": false`). The `openmemory-http` plugin handles all memory operations via direct REST API calls.

### 7. extensionManifest Documentation (R10) — RESOLVED
The `extensionManifest` convention has been removed from documentation.

### 8. Custom Tools (R8) — RESOLVED
Custom Tools (medium-high risk extension sub-type) are now implemented in `opencode/extensions/tools/` with Zod-validated parameters: `memory-query.ts`, `memory-save.ts`, `health-check.ts`.

### 9. Model and Provider Configuration (R9) — RESOLVED
`opencode.jsonc` now specifies `model: "anthropic/claude-sonnet-4-5"` and provider configuration with env-based API key. Provider credentials are managed as Connections in `secrets.env`.

### 10. Agent Markdown Files (R11) — RESOLVED
The `channel-intake` agent (an Agent-type extension, medium risk) is now defined in `gateway/opencode/agents/channel-intake.md` with frontmatter (description, tools), replacing the inline definition in `opencode.jsonc`.

### 11. Config Layering (R6) — RESOLVED
The entrypoint uses `cp -rn` (no-clobber recursive copy) to merge baked-in defaults into `/config/`, ensuring baked-in extensions are available even when the host provides an `opencode.jsonc` override.

### 12. Slash Commands (R12) — RESOLVED
Default slash commands (Command-type extension, low risk) ship in `opencode/extensions/commands/` for memory recall, memory save, and health check operations.

---

## Updated Recommendations

Recommendations are ordered by impact-to-effort ratio.

### R1. Add YAML Frontmatter to Skills (High Impact, Low Effort)

Add frontmatter to both Skill-type extensions:

```markdown
---
name: memory
description: Governs memory storage and recall behavior for the assistant
denied-tools:
  - bash
  - write
  - edit
---

# Memory Policy
...
```

```markdown
---
name: channel-intake
description: Validates, summarizes, and dispatches inbound channel requests
denied-tools:
  - bash
  - write
  - edit
---

# ChannelIntake
...
```

This unlocks OpenCode's auto-discovery, per-skill permission scoping, and the `skill` permission gate.

### R2. Remove Phantom Gallery Entries (High Impact, Low Effort)

Delete the five gallery entries referencing nonexistent files, or create the files. Add a CI check that validates gallery `installTarget` paths exist in the repository.

### R3. Make the Admin Allowlist Dynamic (High Impact, Medium Effort)

Read allowed service names from the compose file or an environment variable:

```typescript
const EXTRA = (Bun.env.OPENPALM_EXTRA_SERVICES ?? "").split(",").filter(Boolean)
const ALLOWED = new Set([
  "opencode-core", "gateway", "openmemory", "admin",
  "channel-chat", "channel-discord", "channel-voice",
  "channel-telegram", "caddy",
  ...EXTRA
])
```

Note: the entries prefixed with `channel-` are Channel services (a separate top-level concept), not Extension sub-types.

### R4. Move Plugins to `plugins/` or Register Explicitly (Medium Impact, Low Effort)

Either move `openmemory-http.ts` and `policy-and-telemetry.ts` to `opencode/extensions/plugins/` (the auto-discovery path for Plugin-type extensions), or add them to the `plugin[]` array in `opencode.jsonc`. The current location under `skills/memory/scripts/` is outside OpenCode's plugin discovery path.

### R5. Resolve the MCP Split-Brain (Medium Impact, Low Effort)

Disable MCP for OpenMemory to close the guardrail bypass:

```jsonc
"mcp": {
  "openmemory": {
    "enabled": false
  }
}
```

Or remove the MCP config entirely and rely solely on the REST plugin.

### R6. Verify and Document the Config Layering Behavior (Medium Impact, Low Effort)

Test whether OpenCode merges the global config directory (`/root/.config/opencode/`) with `$OPENCODE_CONFIG_DIR` (`/config/`), or whether setting `OPENCODE_CONFIG_DIR` suppresses global discovery. If global discovery is suppressed, the entrypoint needs to be updated to always merge baked-in extensions into `/config/` (not just when `opencode.jsonc` is missing), perhaps using `cp -rn` to copy without overwriting.

### R7. Adopt the Plugin Type Signature (Medium Impact, Low Effort)

Refactor plugins to use the standard `Plugin` type from `@opencode-ai/plugin`, ensuring they receive the guaranteed context (`client`, `$`, `project`, etc.).

### R8. Add Custom Tools for Core Operations (Medium Impact, Medium Effort)

Create `opencode/extensions/tools/` with typed Custom Tool extensions (medium-high risk) for memory search, memory save, health checks, and cron/Automation status.

### R9. Specify Model and Provider in Config (Medium Impact, Low Effort)

Add explicit model configuration to the core `opencode.jsonc`. Provider credentials should be referenced from `secrets.env` (managed as Connections via admin API) rather than hardcoded:

```jsonc
{
  "model": "anthropic/claude-sonnet-4-5",
  "provider": {
    "anthropic": {
      "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" }
    }
  }
}
```

### R10. Implement or Remove the `extensionManifest` Documentation (Medium Impact, Variable Effort)

Either build the manifest processing or remove it from docs.

### R11. Move Channel-Intake Agent to a Markdown File (Low Impact, Low Effort)

Create `gateway/opencode/agents/channel-intake.md` with frontmatter, remove the inline definition from `opencode.jsonc`. This Agent-type extension (medium risk) should follow the canonical `agents/<name>.md` directory convention.

### R12. Add Commands for Common Operations (Low Impact, Medium Effort)

Ship default slash commands (Command-type extensions, low risk) under `opencode/extensions/commands/` for common operator tasks. Consider adding a command for listing active Automations.

---

## Summary

The recent restructuring addressed several important issues: Skills (lowest-risk extension sub-type) now follow the correct directory pattern, the gateway config is cleaner with wildcard denials and explicit `instructions`, and the baked-in image architecture provides a better upgrade story than host-seeded extensions.

The five extension sub-types — Skill (lowest risk), Command (low), Agent (medium), Custom Tool (medium-high), and Plugin (highest) — each have distinct directories, risk levels, and discovery mechanisms. Channels are a separate top-level concept that run as dedicated container services and are not Extension sub-types. Connections manage named credentials via the admin API. Automations manage scheduled prompts via Unix cron.

The highest-priority remaining issues are: skills still lack YAML frontmatter (R1), the gallery has phantom entries (R2), the admin allowlist blocks community containers (R3), and plugins are in a non-standard location outside OpenCode's discovery path (R4). The MCP split-brain (R5) is a security concern that's easy to fix. The config layering behavior (R6) needs verification to ensure baked-in extensions are actually available when the host override config is present.
