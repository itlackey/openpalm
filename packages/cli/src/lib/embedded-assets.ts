/**
 * Core assets embedded at build time via Bun text imports.
 *
 * Source of truth is .openpalm/ at the repo root. Bun inlines the file
 * contents at compile time so they're available in compiled binaries
 * without downloading from GitHub.
 */

// @ts-ignore — Bun text import
import coreCompose from "../../../../.openpalm/stack/core.compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import userEnvSchema from "../../../../.openpalm/vault/user/user.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import stackEnvSchema from "../../../../.openpalm/vault/stack/stack.env.schema" with { type: "text" };

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
import openvikingCompose from "../../../../.openpalm/registry/addons/openviking/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import openvikingSchema from "../../../../.openpalm/registry/addons/openviking/.env.schema" with { type: "text" };
// @ts-ignore — Bun text import
import openvikingEntrypoint from "../../../../.openpalm/registry/addons/openviking/entrypoint.sh" with { type: "text" };
// @ts-ignore — Bun text import
import openvikingConfig from "../../../../.openpalm/registry/addons/openviking/config/ov.conf" with { type: "text" };
// @ts-ignore — Bun text import
import cleanupLogsAutomation from "../../../../.openpalm/registry/automations/cleanup-logs.yml" with { type: "text" };
// @ts-ignore — Bun text import
import cleanupDataAutomation from "../../../../.openpalm/registry/automations/cleanup-data.yml" with { type: "text" };
// @ts-ignore — Bun text import
import validateConfigAutomation from "../../../../.openpalm/registry/automations/validate-config.yml" with { type: "text" };
// @ts-ignore — Bun text import
import healthCheckAutomation from "../../../../.openpalm/registry/automations/health-check.yml" with { type: "text" };
// @ts-ignore — Bun text import
import promptAssistantAutomation from "../../../../.openpalm/registry/automations/prompt-assistant.yml" with { type: "text" };
// @ts-ignore — Bun text import
import updateContainersAutomation from "../../../../.openpalm/registry/automations/update-containers.yml" with { type: "text" };
// @ts-ignore — Bun text import
import assistantDailyBriefingAutomation from "../../../../.openpalm/registry/automations/assistant-daily-briefing.yml" with { type: "text" };

export const EMBEDDED_ASSETS: Record<string, string> = {
  "stack/core.compose.yml": coreCompose,
  "registry/addons/admin/compose.yml": adminCompose,
  "registry/addons/admin/.env.schema": adminSchema,
  "registry/addons/chat/compose.yml": chatCompose,
  "registry/addons/chat/.env.schema": chatSchema,
  "registry/addons/api/compose.yml": apiCompose,
  "registry/addons/api/.env.schema": apiSchema,
  "registry/addons/discord/compose.yml": discordCompose,
  "registry/addons/discord/.env.schema": discordSchema,
  "registry/addons/slack/compose.yml": slackCompose,
  "registry/addons/slack/.env.schema": slackSchema,
  "registry/addons/ollama/compose.yml": ollamaCompose,
  "registry/addons/ollama/.env.schema": ollamaSchema,
  "registry/addons/voice/compose.yml": voiceCompose,
  "registry/addons/voice/.env.schema": voiceSchema,
  "registry/addons/openviking/compose.yml": openvikingCompose,
  "registry/addons/openviking/.env.schema": openvikingSchema,
  "registry/addons/openviking/entrypoint.sh": openvikingEntrypoint,
  "registry/addons/openviking/config/ov.conf": openvikingConfig,
  "registry/automations/cleanup-logs.yml": cleanupLogsAutomation,
  "registry/automations/cleanup-data.yml": cleanupDataAutomation,
  "registry/automations/validate-config.yml": validateConfigAutomation,
  "registry/automations/health-check.yml": healthCheckAutomation,
  "registry/automations/prompt-assistant.yml": promptAssistantAutomation,
  "registry/automations/update-containers.yml": updateContainersAutomation,
  "registry/automations/assistant-daily-briefing.yml": assistantDailyBriefingAutomation,
  "vault/user/user.env.schema": userEnvSchema,
  "vault/stack/stack.env.schema": stackEnvSchema,
};

/**
 * Seed critical assets from embedded content (compiled into the Bun binary).
 * Only writes files that don't already exist — never overwrites user edits.
 *
 * CLI-only — the admin reads assets from the filesystem at runtime.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function seedEmbeddedAssets(homeDir: string): void {
  for (const [relPath, content] of Object.entries(EMBEDDED_ASSETS)) {
    const targetPath = join(homeDir, relPath);
    if (existsSync(targetPath)) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content);
  }
}
