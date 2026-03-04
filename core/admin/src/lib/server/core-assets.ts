/**
 * Core asset management for the OpenPalm control plane.
 *
 * Manages DATA_HOME source-of-truth files: Caddyfile and docker-compose.yml.
 * Owns the $assets Vite imports and access scope detection/mutation.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveDataHome } from "./paths.js";

// @ts-ignore — raw asset imports bundled by Vite at build time
import coreComposeAsset from "$assets/docker-compose.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import caddyfileAsset from "$assets/Caddyfile?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import openmemoryMemoryPyAsset from "$assets/openmemory-memory.py?raw";

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

// ── OpenMemory memory.py patch (DATA_HOME) ─────────────────────────────

function openMemoryPatchPath(): string {
  return `${resolveDataHome()}/openmemory/memory.py`;
}

/**
 * Ensure the patched memory.py exists in DATA_HOME/openmemory/.
 * The OpenMemory compose service bind-mounts this file; if it's missing
 * Docker will create a directory at the mount path and the container
 * will fail to start.
 */
export function ensureOpenMemoryPatch(): string {
  const path = openMemoryPatchPath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, openmemoryMemoryPyAsset);
  } else if (sha256(readFileSync(path, "utf-8")) !== sha256(openmemoryMemoryPyAsset)) {
    const backupDir = join(dirname(path), "backups");
    mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, join(backupDir, `memory.${ts}.py`));
    writeFileSync(path, openmemoryMemoryPyAsset);
  }
  return path;
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
  { dataRelPath: "openmemory/memory.py", githubFilename: "openmemory-memory.py" }
];

/**
 * Download an asset from GitHub. Tries the release URL first, then raw.
 * Returns the text content or throws with a descriptive message.
 */
async function downloadAsset(filename: string): Promise<string> {
  const releaseUrl = `https://github.com/${REPO}/releases/download/${VERSION}/${filename}`;
  const rawUrl = `https://raw.githubusercontent.com/${REPO}/${VERSION}/core/assets/${filename}`;

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
