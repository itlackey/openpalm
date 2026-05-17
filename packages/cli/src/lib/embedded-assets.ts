/**
 * Core assets embedded at build time via Bun text imports.
 *
 * Source of truth is .openpalm/ at the repo root. Bun inlines the file
 * contents at compile time so they're available in compiled binaries
 * without downloading from GitHub.
 */

// @ts-ignore — Bun text import
import coreCompose from "../../../../.openpalm/config/stack/core.compose.yml" with { type: "text" };

// Addon compose files
// @ts-ignore — Bun text import
import chatCompose from "../../../../.openpalm/state/registry/addons/chat/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import chatSchema from "../../../../.openpalm/state/registry/addons/chat/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import apiCompose from "../../../../.openpalm/state/registry/addons/api/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import apiSchema from "../../../../.openpalm/state/registry/addons/api/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import discordCompose from "../../../../.openpalm/state/registry/addons/discord/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import discordSchema from "../../../../.openpalm/state/registry/addons/discord/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import slackCompose from "../../../../.openpalm/state/registry/addons/slack/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import slackSchema from "../../../../.openpalm/state/registry/addons/slack/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import ollamaCompose from "../../../../.openpalm/state/registry/addons/ollama/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import ollamaSchema from "../../../../.openpalm/state/registry/addons/ollama/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import voiceCompose from "../../../../.openpalm/state/registry/addons/voice/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import voiceSchema from "../../../../.openpalm/state/registry/addons/voice/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import cleanupLogsAutomation from "../../../../.openpalm/state/registry/automations/cleanup-logs.md" with { type: "text" };
// @ts-ignore — Bun text import
import cleanupDataAutomation from "../../../../.openpalm/state/registry/automations/cleanup-data.md" with { type: "text" };
// @ts-ignore — Bun text import
import validateConfigAutomation from "../../../../.openpalm/state/registry/automations/validate-config.md" with { type: "text" };
// @ts-ignore — Bun text import
import healthCheckAutomation from "../../../../.openpalm/state/registry/automations/health-check.md" with { type: "text" };
// @ts-ignore — Bun text import
import promptAssistantAutomation from "../../../../.openpalm/state/registry/automations/prompt-assistant.md" with { type: "text" };
// @ts-ignore — Bun text import
import updateContainersAutomation from "../../../../.openpalm/state/registry/automations/update-containers.md" with { type: "text" };
// @ts-ignore — Bun text import
import assistantDailyBriefingAutomation from "../../../../.openpalm/state/registry/automations/assistant-daily-briefing.md" with { type: "text" };
// @ts-ignore — Bun text import
import akmImproveAutomation from "../../../../.openpalm/state/registry/automations/akm-improve.md" with { type: "text" };

// ── Stash seeds (built-in skills / commands / agents) ────────────────
// Each seed lives in .openpalm/stash/<type>/<...> and is copied
// into ${OP_HOME}/stash/<type>/<...> on first install. Source of
// truth for the on-disk seed files is `.openpalm/stash/` in the
// repo — add new seeds by dropping a file there and importing it below.
// @ts-ignore — Bun text import
import configDiagnosticsSkill from "../../../../.openpalm/stash/skills/config-diagnostics/SKILL.md" with { type: "text" };

/**
 * Stash seeds keyed by their stash-relative path (relative to
 * `${OP_HOME}/stash/`). Passed to `seedStashAssets()` from
 * `@openpalm/lib`, which writes each entry exactly once and never
 * overwrites an existing file.
 */
export const EMBEDDED_STASH_SEEDS: Record<string, string> = {
  "skills/config-diagnostics/SKILL.md": configDiagnosticsSkill,
};

export const EMBEDDED_ASSETS: Record<string, string> = {
  "config/stack/core.compose.yml": coreCompose,
  "state/registry/addons/chat/compose.yml": chatCompose,
  "state/registry/addons/chat/.env.schema": chatSchema,
  "state/registry/addons/api/compose.yml": apiCompose,
  "state/registry/addons/api/.env.schema": apiSchema,
  "state/registry/addons/discord/compose.yml": discordCompose,
  "state/registry/addons/discord/.env.schema": discordSchema,
  "state/registry/addons/slack/compose.yml": slackCompose,
  "state/registry/addons/slack/.env.schema": slackSchema,
  "state/registry/addons/ollama/compose.yml": ollamaCompose,
  "state/registry/addons/ollama/.env.schema": ollamaSchema,
  "state/registry/addons/voice/compose.yml": voiceCompose,
  "state/registry/addons/voice/.env.schema": voiceSchema,
  "state/registry/automations/cleanup-logs.md": cleanupLogsAutomation,
  "state/registry/automations/cleanup-data.md": cleanupDataAutomation,
  "state/registry/automations/validate-config.md": validateConfigAutomation,
  "state/registry/automations/health-check.md": healthCheckAutomation,
  "state/registry/automations/prompt-assistant.md": promptAssistantAutomation,
  "state/registry/automations/update-containers.md": updateContainersAutomation,
  "state/registry/automations/assistant-daily-briefing.md": assistantDailyBriefingAutomation,
  "state/registry/automations/akm-improve.md": akmImproveAutomation,
};

/**
 * Seed critical assets from embedded content (compiled into the Bun binary).
 * Only writes files that don't already exist — never overwrites user edits.
 *
 * CLI-only — the admin reads assets from the filesystem at runtime.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seedStashAssets } from "@openpalm/lib";

export function seedEmbeddedAssets(homeDir: string): void {
  for (const [relPath, content] of Object.entries(EMBEDDED_ASSETS)) {
    const targetPath = join(homeDir, relPath);
    if (existsSync(targetPath)) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content);
  }
  // Seed the shared akm stash from embedded skills/commands/agents.
  // `seedStashAssets` resolves the target via OP_HOME (which the caller
  // has already set) and is idempotent — user edits to a previously
  // seeded asset are preserved on re-install.
  seedStashAssets(EMBEDDED_STASH_SEEDS);
}
