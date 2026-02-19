# Documentation vs Implementation Discrepancy Report

**Date:** February 19, 2026  
**Scope:** End-to-end review of `/docs` directory comparing documentation to implementation

---

## Executive Summary

The documentation is largely accurate and has been updated to reflect recent fixes. Several issues identified in `extensions-analysis.md` (R1-R12) have been resolved. However, some minor discrepancies remain between documentation and implementation.

---

## SECTION 1: Discrepancies Between Documentation and Code

### 1.1 Extensions Analysis - Plugin Type Signatures (R7 - PARTIALLY RESOLVED)

**Documentation:** `extensions-analysis.md` recommends using `Plugin` type from `@opencode-ai/plugin`

**Implementation:** 
- `opencode/extensions/plugins/openmemory-http.ts:67-68` - Defines local `Plugin` type
- `opencode/extensions/plugins/policy-and-telemetry.ts:17` - Defines local `Plugin` type

**Status:** DISCREPANCY - Plugins use locally-defined types instead of importing from `@opencode-ai/plugin`. The code works but doesn't follow the recommended pattern from the analysis.

---

### 1.2 Extensions Reference - Gateway Agent Configuration

**Documentation:** `extensions-reference.md:148-156` shows inline `agent` configuration in gateway's `opencode.jsonc`:
```jsonc
"agent": {
  "channel-intake": {
    "prompt": "Follow the skills/channel-intake/SKILL.md behavioral rules..."
  }
}
```

**Implementation:** `gateway/opencode/opencode.jsonc` only contains:
```jsonc
{
  "permission": { "*": "deny" },
  "instructions": ["AGENTS.md"]
}
```

**Status:** DISCREPANCY - The documentation shows an old format. The agent is actually invoked in `gateway/src/server.ts:57` via `agent: "channel-intake"` parameter to the OpenCode client, not defined in the config file.

---

### 1.3 API Reference - Setup Wizard Steps

**Documentation:** `api-reference.md:80` lists setup steps:
```
welcome, accessScope, healthCheck, security, channels, extensions
```

**Implementation:** `admin/src/server.ts:268` defines:
```
welcome, accessScope, serviceInstances, healthCheck, security, channels, extensions
```

**Status:** DISCREPANCY - Documentation is missing `serviceInstances` step. The actual implementation includes service instances configuration (lines 295-318 in server.ts).

---

### 1.4 Architecture - Channel Intake Agent Location

**Documentation:** `architecture.md:58` mentions "channel-intake agent" running on opencode-core

**Implementation:** The intake agent is invoked by the gateway but the actual agent definition is loaded from `gateway/opencode/skills/channel-intake/SKILL.md` and `gateway/opencode/agent/channel-intake.md`

**Status:** MINOR AMBIGUITY - Documentation doesn't clearly explain that the gateway sends requests to opencode-core with `agent: "channel-intake"` parameter, which loads the skill from the gateway's baked-in config.

---

### 1.5 Extensions Guide - Plugin Location Description

**Documentation:** `extensions-guide.md:6` says plugins are "auto-discovered from `OPENCODE_CONFIG_DIR/plugins/`"

**Implementation:** Plugins are in `opencode/extensions/plugins/` which gets copied to `/config/plugins/` in the container

**Status:** AMBIGUITY - The documentation is vague about the path resolution. The actual location works because the entrypoint copies extensions to `/config`.

---

## SECTION 2: Resolved Issues (Previously Documented, Now Fixed)

### 2.1 R1 - Skills YAML Frontmatter ✅ FIXED
- Memory skill (`opencode/extensions/skills/memory/SKILL.md`) now has YAML frontmatter
- Channel-intake skill (`gateway/opencode/skills/channel-intake/SKILL.md`) now has YAML frontmatter

### 2.2 R2 - Phantom Gallery Entries ✅ FIXED
- Gallery (`admin/src/gallery.ts`) no longer contains references to non-existent files
- All install targets now exist in the repository

### 2.3 R3 - Controller Dynamic Allowlist ✅ FIXED
- `controller/server.ts:17-21` now supports `OPENPALM_EXTRA_SERVICES` environment variable
- Community container extensions can now be managed

### 2.4 R4 - Plugin Location ✅ FIXED
- Plugins are now in `opencode/extensions/plugins/` which is the auto-discovery path

### 2.5 R5 - MCP Disabled ✅ FIXED
- `opencode/extensions/opencode.jsonc:26-32` explicitly disables MCP

### 2.6 R9 - Model Configuration ✅ FIXED
- `opencode/extensions/opencode.jsonc:4-9` now includes model and provider configuration

### 2.7 R11 - Channel-Intake Agent ✅ FIXED
- `gateway/opencode/agent/channel-intake.md` now exists

---

## SECTION 3: Documentation Gaps (Missing or Unclear)

### 3.1 Missing: Gateway OpenCode Agent Loading Mechanism
**Gap:** Documentation doesn't explain how the gateway's `channel-intake` agent is loaded. The agent is passed as a parameter to the OpenCode client, not defined in the gateway's config file.

**Recommendation:** Add explanation that gateway sends `agent: "channel-intake"` parameter to opencode-core, which loads the skill from the gateway's baked-in extensions.

---

### 3.2 Missing: Plugin Type Import Guidance  
**Gap:** Extensions reference should clarify whether to use local `Plugin` types or import from `@opencode-ai/plugin`.

**Recommendation:** Document the recommended pattern for plugin exports.

---

### 3.3 Unclear: Config Layering Behavior
**Gap:** `extensions-analysis.md:171-181` raises concerns about config layering when host has `opencode.jsonc`. This needs verification and documentation.

**Recommendation:** Document whether OpenCode merges global config (`/root/.config/opencode/`) with project config (`/config/`) or replaces it entirely.

---

### 3.4 Missing: Extension Discovery Path Details
**Gap:** Documentation says plugins are auto-discovered from `plugins/` but doesn't clarify the full path resolution.

**Recommendation:** Document the complete path: `opencode/extensions/plugins/` → copied to `/config/plugins/` in container → auto-discovered by OpenCode.

---

### 3.5 Missing: Custom Tools and Commands Usage
**Gap:** `extensions-reference.md` documents custom tools (`tool/`) and commands (`command/`) but doesn't explain how they're invoked or if they're actually used.

**Implementation:** These exist but aren't clearly integrated:
- `opencode/extensions/tool/memory-query.ts`
- `opencode/extensions/tool/memory-save.ts`
- `opencode/extensions/tool/health-check.ts`
- `opencode/extensions/command/memory-recall.md`

**Recommendation:** Document how these are meant to be used by the agent.

---

### 3.6 Missing: Controller Cron Jobs in Architecture Doc
**Gap:** `architecture.md` doesn't mention the maintenance cron jobs that run in the controller container.

**Implementation:** `controller/entrypoint.sh:8-36` defines 8 cron jobs:
- Pull and restart (daily 3:15)
- Log rotation (hourly at :17)
- Image prune (weekly Sunday 3:45)
- Health check (every 10 min)
- Security scan (daily 2:40)
- Database maintenance (daily 2:20)
- Filesystem cleanup (daily 4:10)
- Metrics report (every 5 min)

**Recommendation:** Add cron-based maintenance to architecture documentation.

---

### 3.7 Missing: OpenCode SSH Configuration
**Gap:** `security.md:57-63` mentions SSH is opt-in but doesn't document the environment variables.

**Implementation:** 
- `docker-compose.yml:79` - `OPENCODE_ENABLE_SSH=${OPENCODE_ENABLE_SSH:-0}`
- `docker-compose.yml:84` - SSH port binding

**Recommendation:** Document `OPENCODE_ENABLE_SSH`, `OPENCODE_CORE_SSH_PORT`, and SSH key setup in `opencode/ssh/` directory.

---

### 3.8 Incomplete: Channel Adapter Environment Variables
**Gap:** `api-reference.md` documents channel endpoints but doesn't list all required environment variables.

**Current in code:**
- `channels/chat/server.ts:3-6` - PORT, GATEWAY_URL, CHANNEL_CHAT_SECRET, CHAT_INBOUND_TOKEN
- Similar patterns for discord, voice, telegram

**Recommendation:** Document all channel-specific environment variables.

---

### 3.9 Missing: Admin Cron Job API
**Gap:** `api-reference.md` doesn't document the cron job endpoints implemented in admin.

**Implementation:** `admin/src/server.ts:545-619` implements:
- `GET /admin/crons` - list jobs
- `POST /admin/crons` - create job
- `POST /admin/crons/update` - update job
- `POST /admin/crons/delete` - delete job
- `POST /admin/crons/trigger` - run job immediately

**Recommendation:** Add cron job API to api-reference.md

---

### 3.10 Missing: Config Editor Policy Lint Details
**Gap:** Multiple docs mention permission widening is blocked but don't detail the validation logic.

**Implementation:** `admin/src/server.ts:632-633`:
```typescript
const permissions = (parsed as Record<string, unknown>).permission as Record<string, string> | undefined;
if (permissions && Object.values(permissions).some((v) => v === "allow")) return cors(json(400, { error: "policy lint failed: permission widening blocked" }));
```

**Recommendation:** Document what constitutes "permission widening" and which permissions can/cannot be set to "allow".

---

## Summary Table

| Category | Count | Status |
|----------|-------|--------|
| Discrepancies Found | 5 | Requires attention |
| Issues Fixed (was in docs) | 7 | ✅ Resolved |
| Documentation Gaps | 10 | Needs documentation |
| **Total** | **22** | |

---

## Recommendations

The documentation is in good shape overall. The main areas needing attention are:

1. **Updating `extensions-reference.md`** - Reflect current gateway agent configuration (agent is passed as parameter, not defined in config)
2. **Adding `serviceInstances` to setup wizard steps** - The documentation is missing this step
3. **Filling the 10 documentation gaps** - Especially around config layering, cron jobs, and cron API endpoints
