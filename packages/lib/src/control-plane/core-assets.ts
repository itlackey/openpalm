/**
 * Core asset management for the OpenPalm control plane.
 *
 * Manages DATA_HOME source-of-truth files: Caddyfile and docker-compose.yml.
 * All asset content is provided by a CoreAssetProvider (injected), not by
 * Vite $assets imports — making this module portable across Bun/Node/Vite.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveDataHome } from "./paths.js";
import { createLogger } from "../logger.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";

const logger = createLogger("core-assets");

// ── Constants ──────────────────────────────────────────────────────────

const PUBLIC_ACCESS_IMPORT = "import public_access";
const LAN_ONLY_IMPORT = "import lan_only";

/** IP ranges for each access scope mode */
const HOST_ONLY_IPS = "127.0.0.0/8 ::1";
const LAN_IPS = "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 ::1 fc00::/7 fe80::/10";
const REMOTE_IP_LINE_RE = /@denied not remote_ip [^\n]+/;

// Re-export for use by staging.ts Caddyfile staging
export { PUBLIC_ACCESS_IMPORT, LAN_ONLY_IMPORT };

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

// ── Core Caddyfile (DATA_HOME source of truth) ─────────────────────────

function coreCaddyfilePath(): string {
  return `${resolveDataHome()}/caddy/Caddyfile`;
}

/**
 * Ensure the system-managed core Caddyfile exists in DATA_HOME.
 * Seeds the bundled asset on first run. On subsequent runs, leaves the
 * existing file intact (user may have customized access scope).
 */
export function ensureCoreCaddyfile(assets: CoreAssetProvider): string {
  const path = coreCaddyfilePath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, assets.caddyfile());
  }
  return path;
}

export function readCoreCaddyfile(assets: CoreAssetProvider): string {
  const path = ensureCoreCaddyfile(assets);
  return readFileSync(path, "utf-8");
}

// ── Env Schema Files (DATA_HOME root) ────────────────────────────────

export function ensureSecretsSchema(assets: CoreAssetProvider): string {
  const path = `${resolveDataHome()}/secrets.env.schema`;
  if (!existsSync(path)) {
    writeFileSync(path, assets.secretsSchema());
  }
  return path;
}

export function ensureStackSchema(assets: CoreAssetProvider): string {
  const path = `${resolveDataHome()}/stack.env.schema`;
  if (!existsSync(path)) {
    writeFileSync(path, assets.stackSchema());
  }
  return path;
}

export function detectAccessScope(rawCaddyfile: string): "host" | "lan" | "custom" {
  const match = rawCaddyfile.match(REMOTE_IP_LINE_RE);
  if (!match) return "custom";
  const ips = match[0].replace("@denied not remote_ip", "").trim();
  if (ips === HOST_ONLY_IPS) return "host";
  if (ips === LAN_IPS) return "lan";
  return "custom";
}

export function setCoreCaddyAccessScope(
  scope: "host" | "lan",
  assets: CoreAssetProvider
): { ok: true } | { ok: false; error: string } {
  const path = ensureCoreCaddyfile(assets);
  const raw = readFileSync(path, "utf-8");
  if (!REMOTE_IP_LINE_RE.test(raw)) {
    return { ok: false, error: "core Caddyfile missing '@denied not remote_ip' line" };
  }
  const ips = scope === "host" ? HOST_ONLY_IPS : LAN_IPS;
  const updated = raw.replace(REMOTE_IP_LINE_RE, `@denied not remote_ip ${ips}`);
  writeFileSync(path, updated);
  return { ok: true };
}

// ── Memory data directory (DATA_HOME) ────────────────────────────────────

export function ensureMemoryDir(): string {
  const dataHome = resolveDataHome();
  const dir = `${dataHome}/memory`;
  const legacyDir = `${dataHome}/openmemory`;

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

// ── Core Compose (DATA_HOME source of truth) ──────────────────────────

function coreComposePath(): string {
  return `${resolveDataHome()}/docker-compose.yml`;
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
    copyFileSync(path, join(backupDir, `docker-compose.${ts}.yml`));
    writeFileSync(path, content);
  }
  return path;
}

export function readCoreCompose(assets: CoreAssetProvider): string {
  const path = ensureCoreCompose(assets);
  return readFileSync(path, "utf-8");
}

// ── Ollama Compose Overlay (DATA_HOME source of truth) ──────────────

function ollamaComposePath(): string {
  return `${resolveDataHome()}/ollama.yml`;
}

export function ensureOllamaCompose(assets: CoreAssetProvider): string {
  const path = ollamaComposePath();
  const content = assets.ollamaCompose();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, content);
  } else if (sha256(readFileSync(path, "utf-8")) !== sha256(content)) {
    const backupDir = join(dirname(path), "backups");
    mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, join(backupDir, `ollama.${ts}.yml`));
    writeFileSync(path, content);
  }
  return path;
}

export function readOllamaCompose(assets: CoreAssetProvider): string {
  const path = ensureOllamaCompose(assets);
  return readFileSync(path, "utf-8");
}

// ── OpenCode System Config (DATA_HOME source of truth) ──────────────

export function ensureOpenCodeSystemConfig(assets: CoreAssetProvider): void {
  const dir = `${resolveDataHome()}/assistant`;
  mkdirSync(dir, { recursive: true });
  writeIfChanged(`${dir}/opencode.jsonc`, assets.opencodeConfig());
  writeIfChanged(`${dir}/AGENTS.md`, assets.agentsMd());
}

// ── Core Automations (DATA_HOME source of truth) ────────────────────

export function ensureCoreAutomations(assets: CoreAssetProvider): void {
  const dir = `${resolveDataHome()}/automations`;
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
const VERSION = process.env.OPENPALM_ASSET_VERSION ?? "main";

const MANAGED_ASSETS: { dataRelPath: string; githubFilename: string }[] = [
  { dataRelPath: "docker-compose.yml", githubFilename: "docker-compose.yml" },
  { dataRelPath: "caddy/Caddyfile", githubFilename: "Caddyfile" },
  { dataRelPath: "assistant/opencode.jsonc", githubFilename: "opencode.jsonc" },
  { dataRelPath: "assistant/AGENTS.md", githubFilename: "AGENTS.md" },
  { dataRelPath: "ollama.yml", githubFilename: "ollama.yml" },
  { dataRelPath: "secrets.env.schema", githubFilename: "secrets.env.schema" },
  { dataRelPath: "stack.env.schema", githubFilename: "stack.env.schema" }
];

async function downloadAsset(filename: string): Promise<string> {
  const releaseUrl = `https://github.com/${REPO}/releases/download/${VERSION}/${filename}`;
  const rawUrl = `https://raw.githubusercontent.com/${REPO}/${VERSION}/assets/${filename}`;

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
  const dataHome = resolveDataHome();
  const updated: string[] = [];
  let backupDir: string | null = null;

  for (const asset of MANAGED_ASSETS) {
    const freshContent = await downloadAsset(asset.githubFilename);
    const targetPath = join(dataHome, asset.dataRelPath);

    if (existsSync(targetPath)) {
      const currentContent = readFileSync(targetPath, "utf-8");
      if (sha256(currentContent) === sha256(freshContent)) {
        continue;
      }

      if (!backupDir) {
        backupDir = join(dataHome, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      }
      const backupPath = join(backupDir, asset.dataRelPath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(targetPath, backupPath);
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, freshContent);
    updated.push(asset.dataRelPath);
  }

  return { backupDir, updated };
}
