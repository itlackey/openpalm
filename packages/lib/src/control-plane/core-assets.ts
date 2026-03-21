/**
 * Core asset management for the OpenPalm control plane.
 *
 * Manages source-of-truth files for the ~/.openpalm/ layout:
 *   stack/              — compose overlays (core.compose.yml, addons/{name}/compose.yml)
 *   vault/              — env schemas
 *
 * All asset content is provided by a CoreAssetProvider (injected), not by
 * Vite $stack imports — making this module portable across Bun/Node/Vite.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveDataDir, resolveConfigDir, resolveVaultDir, resolveOpenPalmHome } from "./home.js";
import { createLogger } from "../logger.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";

const logger = createLogger("core-assets");

/** SHA-256 hex digest of a string. */
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Write content to a file if it has changed, backing up the old version.
 */
function writeIfChanged(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content);
    return;
  }
  const existing = readFileSync(path, "utf-8");
  if (sha256(existing) === sha256(content)) return;

  const backupDir = join(dirname(path), "backups");
  mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const basename = path.split("/").pop()!;
  copyFileSync(path, join(backupDir, `${basename}.${ts}`));
  writeFileSync(path, content);
}

// ── Env Schema Files (vault/) ────────────────────────────────────────

export function ensureUserEnvSchema(assets: CoreAssetProvider): string {
  const vaultDir = resolveVaultDir();
  const dir = `${vaultDir}/user`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/user.env.schema`;
  if (!existsSync(path)) {
    writeFileSync(path, assets.secretsSchema());
  }
  return path;
}

export function ensureSystemEnvSchema(assets: CoreAssetProvider): string {
  const vaultDir = resolveVaultDir();
  const dir = `${vaultDir}/stack`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/stack.env.schema`;
  if (!existsSync(path)) {
    writeFileSync(path, assets.stackSchema());
  }
  return path;
}

// ── Memory data directory ────────────────────────────────────────────

export function ensureMemoryDir(): string {
  const dataDir = resolveDataDir();
  const dir = `${dataDir}/memory`;
  const legacyDir = `${dataDir}/openmemory`;

  if (!existsSync(dir) && existsSync(legacyDir)) {
    try {
      renameSync(legacyDir, dir);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("failed to migrate legacy memory dir", { legacyDir, dir, code, message });
    }
  }

  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Core Compose (stack/) ─────────────────────────────────────────────

function coreComposePath(): string {
  return `${resolveOpenPalmHome()}/stack/core.compose.yml`;
}

export function ensureCoreCompose(assets: CoreAssetProvider): string {
  const path = coreComposePath();
  const content = assets.coreCompose();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, content);
  } else if (sha256(readFileSync(path, "utf-8")) !== sha256(content)) {
    const backupDir = join(dirname(path), "backups");
    mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, join(backupDir, `core.${ts}.yml`));
    writeFileSync(path, content);
  }
  return path;
}

export function readCoreCompose(assets: CoreAssetProvider): string {
  const path = ensureCoreCompose(assets);
  return readFileSync(path, "utf-8");
}

// ── OpenCode System Config ──────────────────────────────────────────

export function ensureOpenCodeSystemConfig(assets: CoreAssetProvider): void {
  const dir = `${resolveDataDir()}/assistant`;
  mkdirSync(dir, { recursive: true });
  writeIfChanged(`${dir}/opencode.jsonc`, assets.opencodeConfig());
  writeIfChanged(`${dir}/AGENTS.md`, assets.agentsMd());
}


// ── Core Automations (config/automations/) ──────────────────────────

export function ensureCoreAutomations(assets: CoreAssetProvider): void {
  const dir = `${resolveConfigDir()}/automations`;
  mkdirSync(dir, { recursive: true });

  const coreAutomations = [
    { filename: "cleanup-logs.yml", content: assets.cleanupLogs() },
    { filename: "cleanup-data.yml", content: assets.cleanupData() },
    { filename: "validate-config.yml", content: assets.validateConfig() },
  ];

  for (const { filename, content } of coreAutomations) {
    writeIfChanged(join(dir, filename), content);
  }
}

// ── Asset Refresh (GitHub download) ──────────────────────────────────

const REPO = "itlackey/openpalm";
const VERSION = process.env.OP_ASSET_VERSION ?? "main";

const MANAGED_ASSETS: { relPath: string; githubFilename: string }[] = [
  { relPath: "stack/core.compose.yml", githubFilename: ".openpalm/stack/core.compose.yml" },
  { relPath: "data/assistant/opencode.jsonc", githubFilename: "core/assistant/opencode.jsonc" },
  { relPath: "data/assistant/AGENTS.md", githubFilename: "core/assistant/AGENTS.md" },
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
  const { resolveOpenPalmHome } = await import("./home.js");
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
