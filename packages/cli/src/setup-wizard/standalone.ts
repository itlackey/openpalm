#!/usr/bin/env bun
/**
 * Standalone setup wizard server — no Docker required.
 *
 * Starts the setup wizard HTTP server for manual testing or Playwright
 * automation without running the full `openpalm install` flow.
 *
 * Usage:
 *   bun run packages/cli/src/setup-wizard/standalone.ts
 *   WIZARD_PORT=9100 bun run packages/cli/src/setup-wizard/standalone.ts
 *
 * Environment:
 *   WIZARD_PORT          — Port to listen on (default: 8100)
 *   OPENPALM_CONFIG_HOME — Config dir override (default: temp dir)
 *   OPENPALM_DATA_HOME   — Data dir override (default: temp dir)
 *   OPENPALM_STATE_HOME  — State dir override (default: temp dir)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreAssetProvider } from "@openpalm/lib";
import { createSetupServer } from "./server.ts";

// ── Configuration ──────────────────────────────────────────────────────

const port = Number(process.env.WIZARD_PORT) || 0;
const useDevDirs = !!(
  process.env.OPENPALM_CONFIG_HOME &&
  process.env.OPENPALM_DATA_HOME &&
  process.env.OPENPALM_STATE_HOME
);

// ── Directory Setup ────────────────────────────────────────────────────

let tempBase: string | null = null;
let configDir: string;
let dataDir: string;
let stateDir: string;

if (useDevDirs) {
  // Use caller-provided directories (e.g. .dev/ paths)
  configDir = process.env.OPENPALM_CONFIG_HOME!;
  dataDir = process.env.OPENPALM_DATA_HOME!;
  stateDir = process.env.OPENPALM_STATE_HOME!;
} else {
  // Create isolated temp directories
  tempBase = mkdtempSync(join(tmpdir(), "openpalm-wizard-dev-"));
  configDir = join(tempBase, "config");
  dataDir = join(tempBase, "data");
  stateDir = join(tempBase, "state");
}

// Ensure required directories exist
for (const dir of [
  configDir,
  join(configDir, "channels"),
  join(configDir, "connections"),
  join(configDir, "assistant"),
  join(configDir, "automations"),
  join(configDir, "stash"),
  dataDir,
  join(dataDir, "admin"),
  join(dataDir, "memory"),
  join(dataDir, "assistant"),
  join(dataDir, "guardian"),
  join(dataDir, "caddy"),
  join(dataDir, "caddy", "data"),
  join(dataDir, "caddy", "config"),
  join(dataDir, "automations"),
  join(dataDir, "opencode"),
  stateDir,
  join(stateDir, "artifacts"),
  join(stateDir, "audit"),
  join(stateDir, "artifacts", "channels"),
  join(stateDir, "automations"),
  join(stateDir, "opencode"),
]) {
  mkdirSync(dir, { recursive: true });
}

// Seed minimal env files so the wizard's status endpoint works
const stackEnvPath = join(stateDir, "artifacts", "stack.env");
writeFileSync(stackEnvPath, "OPENPALM_SETUP_COMPLETE=false\n");

const secretsPath = join(configDir, "secrets.env");
writeFileSync(
  secretsPath,
  [
    "# OpenPalm Secrets (standalone wizard — dev/test)",
    "export OPENPALM_ADMIN_TOKEN=",
    "export ADMIN_TOKEN=",
    "export OPENAI_API_KEY=",
    "export OPENAI_BASE_URL=",
    "export ANTHROPIC_API_KEY=",
    "export GROQ_API_KEY=",
    "export MISTRAL_API_KEY=",
    "export GOOGLE_API_KEY=",
    "export MEMORY_USER_ID=default_user",
    "export MEMORY_AUTH_TOKEN=dev-wizard-token",
    "export OWNER_NAME=",
    "export OWNER_EMAIL=",
    "",
  ].join("\n"),
);

// Point lib's XDG resolvers at our directories
process.env.OPENPALM_CONFIG_HOME = configDir;
process.env.OPENPALM_DATA_HOME = dataDir;
process.env.OPENPALM_STATE_HOME = stateDir;

// ── Stub Asset Provider ────────────────────────────────────────────────
// Provides minimal valid asset content so performSetup() can write config
// files without needing real downloaded assets.

function createStubAssetProvider(): CoreAssetProvider {
  return {
    coreCompose: () => "services:\n  caddy:\n    image: caddy:latest\n",
    caddyfile: () =>
      ":80 {\n  @denied not remote_ip 127.0.0.0/8 ::1\n  respond @denied 403\n}\n",
    ollamaCompose: () => "services:\n  ollama:\n    image: ollama/ollama\n",
    agentsMd: () => "# Agents\n",
    opencodeConfig: () => '{"$schema":"https://opencode.ai/config.json"}\n',
    adminOpencodeConfig: () =>
      '{"$schema":"https://opencode.ai/config.json","plugin":["@openpalm/admin-tools"]}\n',
    secretsSchema: () => "ADMIN_TOKEN=string\n",
    stackSchema: () => "OPENPALM_IMAGE_TAG=string\n",
    cleanupLogs: () => "name: cleanup-logs\nschedule: daily\n",
    cleanupData: () => "name: cleanup-data\nschedule: weekly\n",
    validateConfig: () => "name: validate-config\nschedule: hourly\n",
  };
}

// ── Start Server ───────────────────────────────────────────────────────

const wizard = createSetupServer(port, {
  assetProvider: createStubAssetProvider(),
  configDir,
});

const url = `http://localhost:${wizard.server.port}/setup`;

console.log("");
console.log("  Setup wizard running (standalone mode — no Docker)");
console.log("");
console.log(`  URL:        ${url}`);
console.log(`  Config dir: ${configDir}`);
console.log(`  Data dir:   ${dataDir}`);
console.log(`  State dir:  ${stateDir}`);
console.log("");
console.log("  Press Ctrl+C to stop.");
console.log("");

// ── Graceful Shutdown ──────────────────────────────────────────────────

function shutdown() {
  console.log("\nStopping wizard server...");
  wizard.stop();
  if (tempBase) {
    rmSync(tempBase, { recursive: true, force: true });
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
