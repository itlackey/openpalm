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
import adminCompose from "../../../../.openpalm/stack/addons/admin/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import chatCompose from "../../../../.openpalm/stack/addons/chat/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import apiCompose from "../../../../.openpalm/stack/addons/api/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import discordCompose from "../../../../.openpalm/stack/addons/discord/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import slackCompose from "../../../../.openpalm/stack/addons/slack/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import ollamaCompose from "../../../../.openpalm/stack/addons/ollama/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import voiceCompose from "../../../../.openpalm/stack/addons/voice/compose.yml" with { type: "text" };
// @ts-ignore — Bun text import
import openvikingCompose from "../../../../.openpalm/stack/addons/openviking/compose.yml" with { type: "text" };

export const EMBEDDED_ASSETS: Record<string, string> = {
  "stack/core.compose.yml": coreCompose,
  "stack/addons/admin/compose.yml": adminCompose,
  "stack/addons/chat/compose.yml": chatCompose,
  "stack/addons/api/compose.yml": apiCompose,
  "stack/addons/discord/compose.yml": discordCompose,
  "stack/addons/slack/compose.yml": slackCompose,
  "stack/addons/ollama/compose.yml": ollamaCompose,
  "stack/addons/voice/compose.yml": voiceCompose,
  "stack/addons/openviking/compose.yml": openvikingCompose,
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
