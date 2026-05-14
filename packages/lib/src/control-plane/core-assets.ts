/**
 * Core runtime asset management for the OpenPalm control plane.
 *
 * Manages source-of-truth files for the ~/.openpalm/ layout:
 *   stack/              — compose runtime assets (core.compose.yml)
 *   vault/              — env schemas
 *
 * This module manages runtime-owned core files only.
 * Registry catalog refresh is handled separately in registry.ts.
 * All ensure* functions verify that the expected files exist at OP_HOME.
 * They create directories as needed but do NOT write file content — that
 * is the responsibility of `refreshCoreAssets()` (GitHub download) or
 * the CLI install command (which downloads assets before calling setup).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDataDir, resolveVaultDir, resolveOpenPalmHome, resolveBackupsDir } from "./home.js";
import { createLogger } from "../logger.js";
import { sha256 } from "./crypto.js";

const logger = createLogger("core-assets");

// ── Env Schema Files (vault/) ────────────────────────────────────────

/**
 * Ensure the user env schema directory exists and return the expected
 * schema file path. The file itself may not exist yet — it is written
 * by refreshCoreAssets() or the CLI install command.
 */
export function ensureUserEnvSchema(): string {
  const vaultDir = resolveVaultDir();
  const dir = `${vaultDir}/user`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/user.env.schema`;
  return path;
}

/**
 * Ensure the system env schema directory exists and return the expected
 * schema file path. The file itself may not exist yet — it is written
 * by refreshCoreAssets() or the CLI install command.
 */
export function ensureSystemEnvSchema(): string {
  const vaultDir = resolveVaultDir();
  const dir = `${vaultDir}/stack`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/stack.env.schema`;
  return path;
}

// ── Memory data directory ────────────────────────────────────────────

export function ensureMemoryDir(dataDir?: string): string {
  const resolved = dataDir ?? resolveDataDir();
  const dir = `${resolved}/memory`;
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

// ── Shared akm stash (skills / commands / agents) ────────────────────

/**
 * Relative paths (under `data/stash/`) of every stash asset that ships
 * with OpenPalm. Source of truth lives in `.openpalm/stash-seeds/`.
 *
 * Enumerated in code (rather than discovered at runtime) so the seed set
 * is reviewable and the CLI's embedded record cannot silently drift away
 * from what `refreshCoreAssets()` would download.
 */
export const STASH_SEED_PATHS: { stashRelPath: string; githubFilename: string }[] = [
  {
    stashRelPath: "skills/config-diagnostics/SKILL.md",
    githubFilename: ".openpalm/stash-seeds/skills/config-diagnostics/SKILL.md",
  },
];

/**
 * Seed the shared akm stash with built-in skills / commands / agents.
 *
 * Idempotent: **never overwrites** an existing file — user edits to a
 * seeded asset always win, which preserves the same "config doesn't
 * overwrite user edits" contract that governs the rest of OP_HOME.
 *
 * Returns the list of stash-relative paths that were actually written
 * (empty on re-run when every seed already exists on disk).
 *
 * `seeds` is a map of stash-relative path → file content. The CLI
 * embeds seeds at build time and passes the embedded record directly;
 * the admin builds the same record from fetched content if it ever
 * needs to re-seed at runtime.
 */
export function seedStashAssets(seeds: Record<string, string>): string[] {
  const stashDir = `${resolveDataDir()}/stash`;
  const written: string[] = [];
  for (const [relPath, content] of Object.entries(seeds)) {
    const targetPath = join(stashDir, relPath);
    if (existsSync(targetPath)) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content);
    written.push(relPath);
  }
  return written;
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
        backupDir = join(resolveBackupsDir(), new Date().toISOString().replace(/[:.]/g, "-"));
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
