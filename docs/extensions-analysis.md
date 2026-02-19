# OpenPalm Extensions: Critical Analysis and Recommendations

This document is a technical review of how OpenPalm implements its extension system, evaluated against the capabilities of the OpenCode runtime it depends on. It identifies gaps, structural issues, and concrete recommendations for improvement. It has been updated to reflect recent repository changes.

---

## Changes Since Last Review

Several recommendations from the initial analysis have been partially or fully addressed:

**Addressed: Skills restructured toward OpenCode's directory pattern.** Skills now follow the `skill/<name>/SKILL.md` directory structure (`skills/memory/SKILL.md`, `skills/channel-intake/SKILL.md`). The flat `SkillName.SKILL.md` layout is gone. The `RecallFirst` and `MemoryPolicy` skills were consolidated into a single `memory/SKILL.md`. The `ActionGating` skill was merged into the gateway's `AGENTS.md`.

**Addressed: Gateway config clarity.** The gateway's `opencode.jsonc` now uses wildcard permission denial (`"*": "deny"`), wildcard tool disabling (`"*": false`), and explicitly loads `AGENTS.md` via the `instructions` array. The gateway's config is fully baked into its image with no host volume mount, eliminating the ambiguity about whether it was used.

**Addressed: Extensions baked into images.** Extensions moved from the host-seeded `assets/opencode/` model to being COPY'd into container images at build time from `opencode/extensions/` and `gateway/opencode/`. The host config directory now serves as an override layer rather than the primary extension source. This simplifies the upgrade path — new extensions are delivered via image updates rather than requiring installer re-runs.

**Addressed: `instructions` configuration.** The gateway's `opencode.jsonc` now includes `"instructions": ["AGENTS.md"]`, making AGENTS.md loading explicit.

**Addressed: Repository restructuring.** The `assets/` directory was reorganized into `assets/config/` and `assets/state/`, with extension source code moved to `opencode/extensions/` and `gateway/opencode/`. The registry moved to `assets/state/registry/`. Scripts moved to `assets/state/scripts/`. Channel env files were renamed from `channel-*.env` to just `*.env` under `channels/`.

---

## What Works Well

**Baked-in with host override.** The new architecture bakes extensions into images at build time while allowing host-side overrides via volume mount. This is a significant improvement: it provides a clean upgrade path (pull new image, restart), works out of the box without the installer seeding extensions, and still allows operators to customize without rebuilding.

**Entrypoint fallback logic.** The `opencode-core` entrypoint copies baked-in defaults to `/config` when the host mount is empty. This means the container always works, whether the operator mounts a volume or not.

**Gateway lockdown.** Wildcard denials (`"*": "deny"` for permissions, `"*": false` for tools) in the gateway config are cleaner and more robust than listing individual tools to disable.

**Consolidated memory skill.** Merging `RecallFirst` and `MemoryPolicy` into a single `memory/SKILL.md` reduces skill sprawl and keeps related behavioral rules together.

**Atomic config updates with backups.** The `updatePluginListAtomically()` pattern with temp-file-then-rename and timestamped backups remains solid.

**Config policy lint.** The admin config editor still rejects permission widening, which is a good guardrail.

---

## Remaining Issues

### 1. Skills Still Lack YAML Frontmatter

The directory restructuring adopted the `skill/<name>/SKILL.md` path pattern, which is good. But the skill files still don't include YAML frontmatter:

```markdown
# Memory Policy

## Record

Store memory only when user intent is explicit...
```

OpenCode's skill spec expects:

```markdown
---
name: memory
description: Governs memory storage and recall behavior
denied-tools:
  - bash
  - write
---

# Memory Policy
...
```

Without frontmatter, OpenCode cannot auto-discover skills by name, enforce per-skill tool permissions, or integrate with the `skill` permission gate. Skills currently only work because agent prompts hardcode file paths.

### 2. Plugins Are Located Inside a Skill Directory

The plugin files (`openmemory-http.ts`, `policy-and-telemetry.ts`) and the shared library (`openmemory-client.ts`) now live at `opencode/extensions/skills/memory/scripts/`. This is an unusual location — plugins are not conventionally children of skills.

OpenCode auto-discovers plugins from `$OPENCODE_CONFIG_DIR/plugins/`. Files under `skills/memory/scripts/` are not in the auto-discovery path. This means either:
- The plugins are loaded through some other mechanism (explicit `plugin[]` registration or import from the skill), or
- They are not loaded as OpenCode plugins at all and only function as library code imported by the skill.

If these are meant to be active OpenCode plugins with lifecycle hooks (`tool.execute.before`, `experimental.chat.system.transform`, `event`, etc.), they should be in `plugins/` or explicitly registered in `plugin[]`. If they're script utilities that the skill references, the current location makes sense but the extensions guide's description of them as "plugins" is misleading.

### 3. Plugins Don't Use the OpenCode Plugin Type Signature

The plugin files still export ad-hoc objects rather than using the standard `Plugin` async factory from `@opencode-ai/plugin`:

```typescript
// Current (openmemory-http.ts)
export const OpenMemoryHTTP = async (ctx: {
  client?: any;
  [key: string]: unknown;
}) => { ... }

// Current (policy-and-telemetry.ts)
export const PolicyAndTelemetry = async () => { ... }
```

The standard pattern:

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const OpenMemoryHTTP: Plugin = async ({ client, $ }) => { ... }
```

The `openmemory-http` plugin accesses `ctx.client` as an optional property rather than receiving it as a guaranteed context parameter. This is fragile.

### 4. The Curated Gallery Still Lists Phantom Extensions

The curated gallery in `gallery.ts` still includes entries for files that don't exist:

- `plugin-opencode-memory-guard` → `./plugins/memory-guard.ts` — **doesn't exist**
- `plugin-rate-limit-enforcer` → `./plugins/rate-limit-enforcer.ts` — **doesn't exist**
- `plugin-response-sanitizer` → `./plugins/response-sanitizer.ts` — **doesn't exist**
- `skill-code-review` → `skills/CodeReview.SKILL.md` — **doesn't exist**
- `skill-summarize-context` → `skills/SummarizeContext.SKILL.md` — **doesn't exist**

Installing these creates broken references.

### 5. Controller Allowlist Still Prevents Community Container Extensions

The controller's `ALLOWED` set remains hardcoded:

```typescript
const ALLOWED = new Set([
  "opencode-core", "gateway", "openmemory", "admin",
  "channel-chat", "channel-discord", "channel-voice",
  "channel-telegram", "caddy"
]);
```

The gallery advertises `n8n`, `ollama`, and `searxng`, and the community registry supports arbitrary `compose-service` targets, but the controller rejects operations for any unlisted service. Installing a community container extension appears to succeed from the admin API but silently fails at the controller.

### 6. MCP Still Enabled Alongside the REST Plugin

The core `opencode.jsonc` still enables MCP for OpenMemory while the `openmemory-http` plugin uses direct REST calls. The agent can see and use MCP memory tools, bypassing the plugin's secret detection and save-worthiness checks.

### 7. The `extensionManifest` Convention Is Still Documented but Not Implemented

The extensions guide still describes a convention where plugins export `extensionManifest` objects and the admin service processes them. No code in the admin service reads or processes these manifests.

### 8. Custom Tools Are Unused

OpenCode's `.opencode/tool/` system (Zod-validated, LLM-callable functions) is not used. Memory operations, health checks, and cron management are all candidates for typed custom tools.

### 9. No Model or Provider Configuration

Neither `opencode.jsonc` specifies a `model`, `provider`, or `small_model`. The model selection is implicit, depending on environment variables.

### 10. No Agent Markdown Files

The `channel-intake` agent is still defined inline in `opencode.jsonc` rather than as a standalone `.md` file with rich frontmatter (model, temperature, mode, tools, permissions).

### 11. Baked-In Extensions Make the Override Story Complex

While baking extensions into images is cleaner for upgrades, it creates a subtle interaction with the host override layer. If an operator mounts a volume at `/config` with just an `opencode.jsonc` (which is what the installer seeds), the entrypoint finds the config file and uses `/config` as the config directory. But the baked-in skills and plugins at `/root/.config/opencode/` are no longer in the active config path.

The entrypoint only copies baked-in defaults when `opencode.jsonc` is **missing** from `/config`. If it's present (even as an empty `{}`), no copying occurs. This means:
- Host has `opencode.jsonc` → OpenCode uses `/config` → baked-in `skills/`, `AGENTS.md` are NOT in the config path
- Host has nothing → entrypoint copies everything → all baked-in extensions are available

The installer seeds an empty `opencode.jsonc`, which triggers the first case. The baked-in extensions would not be available unless the operator also copies them to the host, or unless OpenCode's config merging combines the baked-in global config (`/root/.config/opencode/`) with the project-level config (`/config/`).

This needs verification: does OpenCode merge `~/.config/opencode/` (global) with `$OPENCODE_CONFIG_DIR` (project), or does `$OPENCODE_CONFIG_DIR` replace global discovery entirely?

---

## Updated Recommendations

Recommendations are ordered by impact-to-effort ratio.

### R1. Add YAML Frontmatter to Skills (High Impact, Low Effort)

Add frontmatter to both skills:

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

### R3. Make the Controller Allowlist Dynamic (High Impact, Medium Effort)

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

### R4. Move Plugins to `plugins/` or Register Explicitly (Medium Impact, Low Effort)

Either move `openmemory-http.ts` and `policy-and-telemetry.ts` to `opencode/extensions/plugins/` (the auto-discovery path), or add them to the `plugin[]` array in `opencode.jsonc`. The current location under `skills/memory/scripts/` is outside OpenCode's plugin discovery path.

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

Create `opencode/extensions/tool/` with typed tools for memory search, memory save, health checks, and cron status.

### R9. Specify Model and Provider in Config (Medium Impact, Low Effort)

Add explicit model configuration to the core `opencode.jsonc`:

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

Create `gateway/opencode/agent/channel-intake.md` with frontmatter, remove the inline definition from `opencode.jsonc`.

### R12. Add Commands for Common Operations (Low Impact, Medium Effort)

Ship default slash commands under `opencode/extensions/command/` for common operator tasks.

---

## Summary

The recent restructuring addressed several important issues: skills now follow the correct directory pattern, the gateway config is cleaner with wildcard denials and explicit `instructions`, and the baked-in image architecture provides a better upgrade story than host-seeded extensions.

The highest-priority remaining issues are: skills still lack YAML frontmatter (R1), the gallery has phantom entries (R2), the controller allowlist blocks community containers (R3), and plugins are in a non-standard location outside OpenCode's discovery path (R4). The MCP split-brain (R5) is a security concern that's easy to fix. The config layering behavior (R6) needs verification to ensure baked-in extensions are actually available when the host override config is present.