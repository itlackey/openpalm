/**
 * Core asset management for the OpenPalm control plane.
 *
 * Manages source-of-truth files for the ~/.openpalm/ layout:
 *   stack/              — compose overlays (core.compose.yml, addons/{name}/compose.yml)
 *   vault/              — env schemas
 *
 * All ensure* functions verify that the expected files exist at OP_HOME.
 * They create directories as needed but do NOT write file content — that
 * is the responsibility of `refreshCoreAssets()` (GitHub download) or
 * the CLI install command (which downloads assets before calling setup).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveDataDir, resolveConfigDir, resolveVaultDir, resolveOpenPalmHome } from "./home.js";
import { createLogger } from "../logger.js";

const logger = createLogger("core-assets");

/** SHA-256 hex digest of a string. */
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Env Schema Files (vault/) ────────────────────────────────────────

export function ensureUserEnvSchema(): string {
  const vaultDir = resolveVaultDir();
  const dir = `${vaultDir}/user`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/user.env.schema`;
  return path;
}

export function ensureSystemEnvSchema(): string {
  const vaultDir = resolveVaultDir();
  const dir = `${vaultDir}/stack`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/stack.env.schema`;
  return path;
}

// ── Memory data directory ────────────────────────────────────────────

export function ensureMemoryDir(): string {
  const dataDir = resolveDataDir();
  const dir = `${dataDir}/memory`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Core Compose (stack/) ─────────────────────────────────────────────

function coreComposePath(): string {
  return `${resolveOpenPalmHome()}/stack/core.compose.yml`;
}

export function ensureCoreCompose(): string {
  const path = coreComposePath();
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function readCoreCompose(): string {
  const path = coreComposePath();
  return readFileSync(path, "utf-8");
}

// ── OpenCode System Config ──────────────────────────────────────────

export function ensureOpenCodeSystemConfig(): void {
  const dir = `${resolveDataDir()}/assistant`;
  mkdirSync(dir, { recursive: true });
}

// ── Core Automations (config/automations/) ──────────────────────────

export function ensureCoreAutomations(): void {
  const dir = `${resolveConfigDir()}/automations`;
  mkdirSync(dir, { recursive: true });
}

// ── Asset Refresh (GitHub download) ──────────────────────────────────

const REPO = "itlackey/openpalm";
const VERSION = process.env.OP_ASSET_VERSION ?? "main";

const MANAGED_ASSETS: { relPath: string; githubFilename: string }[] = [
  { relPath: "stack/core.compose.yml", githubFilename: ".openpalm/stack/core.compose.yml" },
  { relPath: "data/assistant/opencode.jsonc", githubFilename: "core/assistant/opencode/opencode.jsonc" },
  { relPath: "data/assistant/AGENTS.md", githubFilename: "core/assistant/opencode/AGENTS.md" },
  { relPath: "vault/user/user.env.schema", githubFilename: ".openpalm/vault/user/user.env.schema" },
  { relPath: "vault/stack/stack.env.schema", githubFilename: ".openpalm/vault/stack/stack.env.schema" },
  { relPath: "config/automations/cleanup-logs.yml", githubFilename: ".openpalm/config/automations/cleanup-logs.yml" },
  { relPath: "config/automations/cleanup-data.yml", githubFilename: ".openpalm/config/automations/cleanup-data.yml" },
  { relPath: "config/automations/validate-config.yml", githubFilename: ".openpalm/config/automations/validate-config.yml" },
];

async function downloadAsset(filename: string): Promise<string> {
  const releaseUrl = `https://github.com/${REPO}/releases/download/${VERSION}/${filename}`;
  const rawUrl = `https://raw.githubusercontent.com/${REPO}/${VERSION}/${filename}`;

  for (const url of [releaseUrl, rawUrl]) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch {
      // try next URL
    }
  }
  throw new Error(`Failed to download ${filename} from GitHub (tried release and raw URLs for version "${VERSION}")`);
}

export async function refreshCoreAssets(): Promise<{
  backupDir: string | null;
  updated: string[];
}> {
  const homeDir = resolveOpenPalmHome();
  const updated: string[] = [];
  let backupDir: string | null = null;

  for (const asset of MANAGED_ASSETS) {
    const freshContent = await downloadAsset(asset.githubFilename);
    const targetPath = join(homeDir, asset.relPath);

    if (existsSync(targetPath)) {
      const currentContent = readFileSync(targetPath, "utf-8");
      if (sha256(currentContent) === sha256(freshContent)) {
        continue;
      }

      if (!backupDir) {
        backupDir = join(homeDir, "data/backups", new Date().toISOString().replace(/[:.]/g, "-"));
      }
      const backupPath = join(backupDir, asset.relPath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(targetPath, backupPath);
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, freshContent);
    updated.push(asset.relPath);
  }

  return { backupDir, updated };
}
