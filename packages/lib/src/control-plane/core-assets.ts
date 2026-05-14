/**
 * Core runtime asset management for the OpenPalm control plane.
 *
 * Manages source-of-truth files for the ~/.openpalm/ layout:
 *   stack/              — compose runtime assets (core.compose.yml)
 *
 * This module manages runtime-owned core files only.
 * Registry catalog refresh is handled separately in registry.ts.
 * Env validation has moved to `akm vault` + the in-house redactor — the
 * historical `.env.schema` files (varlock format) were retired in #391.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { resolveDataDir, resolveOpenPalmHome, resolveBackupsDir } from "./home.js";
import { createLogger } from "../logger.js";
import { sha256 } from "./crypto.js";

const logger = createLogger("core-assets");

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
 * Seed the shared akm stash with built-in skills / commands / agents.
 *
 * Idempotent: **never overwrites** an existing file — user edits to a
 * seeded asset always win, which preserves the same "config doesn't
 * overwrite user edits" contract that governs the rest of OP_HOME.
 *
 * Returns the list of stash-relative paths that were actually written
 * (empty on re-run when every seed already exists on disk).
 *
 * `seeds` is a map of stash-relative path → file content. Keys MUST be
 * forward-slash relative paths that stay inside `data/stash/`; any key
 * that escapes the stash directory after canonicalization throws,
 * preventing a malicious caller from writing arbitrary files. Source of
 * truth for the seeded files lives at `.openpalm/stash-seeds/` in the
 * repo; the CLI embeds them at build time and passes the embedded
 * record directly.
 */
export function seedStashAssets(seeds: Record<string, string>): string[] {
  const stashDir = `${resolveDataDir()}/stash`;
  const normalizedStash = resolve(stashDir);
  const written: string[] = [];
  for (const [relPath, content] of Object.entries(seeds)) {
    const targetPath = join(stashDir, relPath);
    const normalizedTarget = resolve(targetPath);
    if (
      normalizedTarget !== normalizedStash &&
      !normalizedTarget.startsWith(normalizedStash + sep)
    ) {
      throw new Error(`Seed path escapes stash dir: ${relPath}`);
    }
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

// Stash seeds are intentionally NOT in this list — they use seedStashAssets()
// which never overwrites existing files (user edits win on re-install).
const MANAGED_ASSETS: { relPath: string; githubFilename: string }[] = [
  { relPath: "stack/core.compose.yml", githubFilename: ".openpalm/stack/core.compose.yml" },
  { relPath: "data/assistant/opencode.jsonc", githubFilename: "core/assistant/opencode/opencode.jsonc" },
  { relPath: "data/assistant/AGENTS.md", githubFilename: "core/assistant/opencode/AGENTS.md" },
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
