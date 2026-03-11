/**
 * Core asset management for the OpenPalm control plane.
 *
 * Manages DATA_HOME source-of-truth files: Caddyfile and docker-compose.yml.
 * Owns the $assets Vite imports and access scope detection/mutation.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveDataHome } from "./paths.js";
import { createLogger } from "./logger.js";

const logger = createLogger("core-assets");

// @ts-ignore — raw asset imports bundled by Vite at build time
import coreComposeAsset from "$assets/docker-compose.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import caddyfileAsset from "$assets/Caddyfile?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import opencodeConfigAsset from "$assets/opencode.jsonc?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import agentsMdAsset from "$assets/AGENTS.md?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import ollamaComposeAsset from "$assets/ollama.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import cleanupLogsAsset from "$assets/cleanup-logs.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import cleanupDataAsset from "$assets/cleanup-data.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import secretsSchemaAsset from "$assets/secrets.env.schema?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import stackSchemaAsset from "$assets/stack.env.schema?raw";

// ── Constants ──────────────────────────────────────────────────────────

const PUBLIC_ACCESS_IMPORT = "import public_access";
const LAN_ONLY_IMPORT = "import lan_only";

/** IP ranges for each access scope mode */
const HOST_ONLY_IPS = "127.0.0.0/8 ::1";
const LAN_IPS = "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 ::1 fc00::/7 fe80::/10";
const REMOTE_IP_LINE_RE = /@denied not remote_ip [^\n]+/;

// Re-export for use by staging.ts Caddyfile staging
export { PUBLIC_ACCESS_IMPORT, LAN_ONLY_IMPORT };

// ── Core Caddyfile (DATA_HOME source of truth) ─────────────────────────

function coreCaddyfilePath(): string {
  return `${resolveDataHome()}/caddy/Caddyfile`;
}

/**
 * Ensure the system-managed core Caddyfile exists in DATA_HOME.
 * Seeds the bundled asset on first run. On subsequent runs, leaves the
 * existing file intact (user may have customized access scope).
 */
export function ensureCoreCaddyfile(): string {
  const path = coreCaddyfilePath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, caddyfileAsset);
  }
  return path;
}

export function readCoreCaddyfile(): string {
  const path = ensureCoreCaddyfile();
  return readFileSync(path, "utf-8");
}

// ── Env Schema Files (DATA_HOME root) ────────────────────────────────

/**
 * Ensure the secrets.env.schema file exists in DATA_HOME.
 * Seeds the bundled asset on first run; leaves the existing file intact
 * on subsequent runs.
 */
export function ensureSecretsSchema(): string {
  const path = `${resolveDataHome()}/secrets.env.schema`;
  if (!existsSync(path)) {
    writeFileSync(path, secretsSchemaAsset);
  }
  return path;
}

/**
 * Ensure the stack.env.schema file exists in DATA_HOME.
 * Seeds the bundled asset on first run; leaves the existing file intact
 * on subsequent runs.
 */
export function ensureStackSchema(): string {
  const path = `${resolveDataHome()}/stack.env.schema`;
  if (!existsSync(path)) {
    writeFileSync(path, stackSchemaAsset);
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

export function setCoreCaddyAccessScope(scope: "host" | "lan"): { ok: true } | { ok: false; error: string } {
  const path = ensureCoreCaddyfile();
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
// Ensure the memory data directory exists. Returns the directory path.
// Migrates legacy DATA_HOME/openmemory/ to DATA_HOME/memory/ on first run.

export function ensureMemoryDir(): string {
  const dataHome = resolveDataHome();
  const dir = `${dataHome}/memory`;
  const legacyDir = `${dataHome}/openmemory`;

  // Migrate legacy directory if it exists and new one doesn't
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

/**
 * Ensure the system-managed core docker-compose.yml in DATA_HOME is
 * up to date with the bundled asset. Seeds on first run; on subsequent
 * runs, overwrites if the bundled version has changed (e.g. after an
 * image rebuild). This prevents stale compose definitions after upgrades.
 */
export function ensureCoreCompose(): string {
  const path = coreComposePath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, coreComposeAsset);
  } else if (sha256(readFileSync(path, "utf-8")) !== sha256(coreComposeAsset)) {
    // Back up the stale file before overwriting
    const backupDir = join(dirname(path), "backups");
    mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, join(backupDir, `docker-compose.${ts}.yml`));
    writeFileSync(path, coreComposeAsset);
  }
  return path;
}

export function readCoreCompose(): string {
  const path = ensureCoreCompose();
  return readFileSync(path, "utf-8");
}

// ── Ollama Compose Overlay (DATA_HOME source of truth) ──────────────

function ollamaComposePath(): string {
  return `${resolveDataHome()}/ollama.yml`;
}

/**
 * Ensure the Ollama compose overlay exists in DATA_HOME.
 * Seeds/updates from the bundled asset, same pattern as core compose.
 */
export function ensureOllamaCompose(): string {
  const path = ollamaComposePath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, ollamaComposeAsset);
  } else if (sha256(readFileSync(path, "utf-8")) !== sha256(ollamaComposeAsset)) {
    const backupDir = join(dirname(path), "backups");
    mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, join(backupDir, `ollama.${ts}.yml`));
    writeFileSync(path, ollamaComposeAsset);
  }
  return path;
}

export function readOllamaCompose(): string {
  const path = ensureOllamaCompose();
  return readFileSync(path, "utf-8");
}

// ── OpenCode System Config (DATA_HOME source of truth) ──────────────

/**
 * Ensure the system-managed OpenCode config exists in DATA_HOME/assistant/.
 * Seeds opencode.jsonc and AGENTS.md from bundled assets. On subsequent
 * runs, overwrites if the bundled version has changed (e.g. after an
 * image rebuild). Backs up stale files before overwriting.
 *
 * IMPORTANT: The project config (opencode.jsonc) only accepts a limited
 * set of keys: $schema, plugin. Provider configuration (providers,
 * model, smallModel) belongs in the USER config (opencode.json) at
 * CONFIG_HOME/assistant/. Provider base URLs are configured via env vars
 * (e.g. LMSTUDIO_BASE_URL) set in compose.dev.yaml or docker-compose.yml.
 */
export function ensureOpenCodeSystemConfig(): void {
  const dir = `${resolveDataHome()}/assistant`;
  mkdirSync(dir, { recursive: true });
  writeIfChanged(`${dir}/opencode.jsonc`, opencodeConfigAsset);
  writeIfChanged(`${dir}/AGENTS.md`, agentsMdAsset);
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

// ── Core Automations (DATA_HOME source of truth) ────────────────────

/**
 * Core automation definitions bundled into the admin image.
 * Each entry maps a filename to its bundled content.
 *
 * Core automations are seeded to DATA_HOME/automations/ on startup.
 * They are non-destructive: existing files are only updated if the bundled
 * version has changed (same write-if-changed pattern as other core assets).
 * Users can override any core automation by placing a file with the same
 * name in CONFIG_HOME/automations/.
 */
const CORE_AUTOMATIONS: { filename: string; content: string }[] = [
  { filename: "cleanup-logs.yml", content: cleanupLogsAsset },
  { filename: "cleanup-data.yml", content: cleanupDataAsset }
];

/**
 * Ensure core automation files exist in DATA_HOME/automations/.
 * Seeds on first run; updates if the bundled version has changed.
 * This follows the same write-if-changed + backup pattern used by
 * ensureCoreCompose and ensureOpenCodeSystemConfig.
 */
export function ensureCoreAutomations(): void {
  const dir = `${resolveDataHome()}/automations`;
  mkdirSync(dir, { recursive: true });

  for (const { filename, content } of CORE_AUTOMATIONS) {
    writeIfChanged(join(dir, filename), content);
  }
}

// ── Asset Refresh (GitHub download) ──────────────────────────────────

const REPO = "itlackey/openpalm";
const VERSION = process.env.OPENPALM_ASSET_VERSION ?? "main";

/** SHA-256 hex digest of a string. */
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Assets to manage: relative path within DATA_HOME → filename on GitHub.
 * The key is the relative path under DATA_HOME; the GitHub filename is the
 * last segment.
 */
const MANAGED_ASSETS: { dataRelPath: string; githubFilename: string }[] = [
  { dataRelPath: "docker-compose.yml", githubFilename: "docker-compose.yml" },
  { dataRelPath: "caddy/Caddyfile", githubFilename: "Caddyfile" },
  { dataRelPath: "assistant/opencode.jsonc", githubFilename: "opencode.jsonc" },
  { dataRelPath: "assistant/AGENTS.md", githubFilename: "AGENTS.md" },
  { dataRelPath: "ollama.yml", githubFilename: "ollama.yml" },
  { dataRelPath: "secrets.env.schema", githubFilename: "secrets.env.schema" },
  { dataRelPath: "stack.env.schema", githubFilename: "stack.env.schema" }
];

/**
 * Download an asset from GitHub. Tries the release URL first, then raw.
 * Returns the text content or throws with a descriptive message.
 */
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

/**
 * Download latest core assets from GitHub, back up changed files, and
 * overwrite DATA_HOME with the fresh versions.
 *
 * Returns the backup directory (if any files were backed up) and the list
 * of asset paths that were updated.
 */
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

    // Compare with existing file (if any)
    if (existsSync(targetPath)) {
      const currentContent = readFileSync(targetPath, "utf-8");
      if (sha256(currentContent) === sha256(freshContent)) {
        continue; // identical — skip
      }

      // Back up the current file before overwriting
      if (!backupDir) {
        backupDir = join(dataHome, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      }
      const backupPath = join(backupDir, asset.dataRelPath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(targetPath, backupPath);
    }

    // Write the fresh content
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, freshContent);
    updated.push(asset.dataRelPath);
  }

  return { backupDir, updated };
}
