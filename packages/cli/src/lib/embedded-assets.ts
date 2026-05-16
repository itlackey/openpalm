/**
 * Core assets embedded at build time via Bun text imports.
 *
 * Source of truth is .openpalm/ at the repo root. Bun inlines the file
 * contents at compile time so they're available in compiled binaries
 * without downloading from GitHub.
 */

// ── Admin build tarball — embedded at CLI compile time ───────────────────
// Build: cd packages/admin && npm run build && npm run build:tar
// The resulting packages/admin/dist/admin-build.tar.gz is embedded here.
// @ts-ignore — Bun binary import
import ADMIN_BUILD_TAR from "../../../admin/dist/admin-build.tar.gz" with { type: "binary" };
import cliPkg from "../../package.json" with { type: "json" };

export const EMBEDDED_ADMIN_TAR: Uint8Array = ADMIN_BUILD_TAR as unknown as Uint8Array;
export const ADMIN_BUILD_VERSION: string = cliPkg.version;

// @ts-ignore — Bun text import
import coreCompose from "../../../../.openpalm/stack/core.compose.yml" with { type: "text" };

// Addon compose files
// @ts-ignore — Bun text import
import adminCompose from "../../../../.openpalm/registry/addons/admin/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import adminSchema from "../../../../.openpalm/registry/addons/admin/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import chatCompose from "../../../../.openpalm/registry/addons/chat/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import chatSchema from "../../../../.openpalm/registry/addons/chat/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import apiCompose from "../../../../.openpalm/registry/addons/api/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import apiSchema from "../../../../.openpalm/registry/addons/api/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import discordCompose from "../../../../.openpalm/registry/addons/discord/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import discordSchema from "../../../../.openpalm/registry/addons/discord/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import slackCompose from "../../../../.openpalm/registry/addons/slack/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import slackSchema from "../../../../.openpalm/registry/addons/slack/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import ollamaCompose from "../../../../.openpalm/registry/addons/ollama/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import ollamaSchema from "../../../../.openpalm/registry/addons/ollama/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import voiceCompose from "../../../../.openpalm/registry/addons/voice/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import voiceSchema from "../../../../.openpalm/registry/addons/voice/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import cleanupLogsAutomation from "../../../../.openpalm/registry/automations/cleanup-logs.md" with { type: "text" };
// @ts-ignore — Bun text import
import cleanupDataAutomation from "../../../../.openpalm/registry/automations/cleanup-data.md" with { type: "text" };
// @ts-ignore — Bun text import
import validateConfigAutomation from "../../../../.openpalm/registry/automations/validate-config.md" with { type: "text" };
// @ts-ignore — Bun text import
import healthCheckAutomation from "../../../../.openpalm/registry/automations/health-check.md" with { type: "text" };
// @ts-ignore — Bun text import
import promptAssistantAutomation from "../../../../.openpalm/registry/automations/prompt-assistant.md" with { type: "text" };
// @ts-ignore — Bun text import
import updateContainersAutomation from "../../../../.openpalm/registry/automations/update-containers.md" with { type: "text" };
// @ts-ignore — Bun text import
import assistantDailyBriefingAutomation from "../../../../.openpalm/registry/automations/assistant-daily-briefing.md" with { type: "text" };
// @ts-ignore — Bun text import
import akmImproveAutomation from "../../../../.openpalm/registry/automations/akm-improve.md" with { type: "text" };

// ── Stash seeds (built-in skills / commands / agents) ────────────────
// Each seed lives in .openpalm/stash-seeds/<type>/<...> and is copied
// into ${OP_HOME}/data/stash/<type>/<...> on first install. Source of
// truth for the on-disk seed files is `.openpalm/stash-seeds/` in the
// repo — add new seeds by dropping a file there and importing it below.
// @ts-ignore — Bun text import
import configDiagnosticsSkill from "../../../../.openpalm/stash-seeds/skills/config-diagnostics/SKILL.md" with { type: "text" };

/**
 * Stash seeds keyed by their stash-relative path (relative to
 * `${OP_HOME}/data/stash/`). Passed to `seedStashAssets()` from
 * `@openpalm/lib`, which writes each entry exactly once and never
 * overwrites an existing file.
 */
export const EMBEDDED_STASH_SEEDS: Record<string, string> = {
  "skills/config-diagnostics/SKILL.md": configDiagnosticsSkill,
};

export const EMBEDDED_ASSETS: Record<string, string> = {
  "stack/core.compose.yml": coreCompose,
  "state/registry/addons/admin/compose.yml": adminCompose,
  "state/registry/addons/admin/.env.schema": adminSchema,
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
