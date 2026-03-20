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
 *   WIZARD_PORT          — Port to listen on (default: ephemeral/random)
 *   OP_HOME        — Home dir override (default: temp dir)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreAssetProvider } from "@openpalm/lib";
import { createSetupServer } from "./server.ts";

// ── Configuration ──────────────────────────────────────────────────────

const port = Number(process.env.WIZARD_PORT) || 0;
const useDevDirs = !!process.env.OP_HOME;

// ── Directory Setup ────────────────────────────────────────────────────

let tempBase: string | null = null;
let homeDir: string;

if (useDevDirs) {
  // Use caller-provided home directory (e.g. .dev/ paths)
  homeDir = process.env.OP_HOME!;
} else {
  // Create isolated temp directory
  tempBase = mkdtempSync(join(tmpdir(), "openpalm-wizard-dev-"));
  homeDir = tempBase;
}

const configDir = join(homeDir, "config");
const vaultDir = join(homeDir, "vault");
const dataDir = join(homeDir, "data");
const logsDir = join(homeDir, "logs");

// Ensure required directories exist
for (const dir of [
  configDir,
  join(configDir, "components"),
  join(configDir, "connections"),
  join(configDir, "assistant"),
  join(configDir, "automations"),
  vaultDir,
  dataDir,
  join(dataDir, "admin"),
  join(dataDir, "memory"),
  join(dataDir, "assistant"),
  join(dataDir, "guardian"),
  join(dataDir, "stash"),
  join(dataDir, "workspace"),
  logsDir,
  join(logsDir, "opencode"),
]) {
  mkdirSync(dir, { recursive: true });
}

// Seed minimal env files so the wizard's status endpoint works
const systemEnvPath = join(vaultDir, "system.env");
writeFileSync(systemEnvPath, "OP_SETUP_COMPLETE=false\n");

const userEnvPath = join(vaultDir, "user.env");
writeFileSync(
  userEnvPath,
  [
    "# OpenPalm Secrets (standalone wizard — dev/test)",
    "export OP_ADMIN_TOKEN=",
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

// Point lib's home resolver at our directory
process.env.OP_HOME = homeDir;

// ── Stub Asset Provider ────────────────────────────────────────────────
// Provides minimal valid asset content so performSetup() can write config
// files without needing real downloaded assets.

function createStubAssetProvider(): CoreAssetProvider {
  return {
    coreCompose: () => "services:\n  admin:\n    image: admin:latest\n",
    agentsMd: () => "# Agents\n",
    opencodeConfig: () => '{"$schema":"https://opencode.ai/config.json"}\n',
    secretsSchema: () => "ADMIN_TOKEN=string\n",
    stackSchema: () => "OP_IMAGE_TAG=string\n",
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
console.log(`  Home dir:   ${homeDir}`);
console.log(`  Config dir: ${configDir}`);
console.log(`  Vault dir:  ${vaultDir}`);
console.log(`  Data dir:   ${dataDir}`);
console.log(`  Logs dir:   ${logsDir}`);
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
