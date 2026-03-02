/**
 * Core asset management for the OpenPalm control plane.
 *
 * Manages DATA_HOME source-of-truth files: Caddyfile and docker-compose.yml.
 * Owns the $assets Vite imports and access scope detection/mutation.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDataHome } from "./paths.js";

// @ts-ignore — raw asset imports bundled by Vite at build time
import coreComposeAsset from "$assets/docker-compose.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import caddyfileAsset from "$assets/Caddyfile?raw";

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
 * This file is the source of truth for access scope policy.
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

// ── Core Compose (DATA_HOME source of truth) ──────────────────────────

function coreComposePath(): string {
  return `${resolveDataHome()}/docker-compose.yml`;
}

/**
 * Ensure the system-managed core docker-compose.yml exists in DATA_HOME.
 * This file is the source of truth for the base compose definition.
 */
export function ensureCoreCompose(): string {
  const path = coreComposePath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, coreComposeAsset);
  }
  return path;
}

export function readCoreCompose(): string {
  const path = ensureCoreCompose();
  return readFileSync(path, "utf-8");
}
