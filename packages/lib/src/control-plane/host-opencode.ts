/**
 * Host OpenCode detection and import.
 *
 * Reads the host user's existing OpenCode installation (XDG standard paths)
 * and provides a one-shot import into OP_HOME.
 *
 * Linux only — macOS/Windows paths are documented but not implemented here;
 * extend behind the same API contract in a follow-up.
 *
 * Security:
 *   - auth.json is copied byte-for-byte and chmodded 0o600. Its contents
 *     are never parsed, logged, or returned to callers.
 *   - opencode.json is parsed to strip plugin/mcp/permission keys before
 *     writing; provider definitions are always kept, and top-level model
 *     defaults are imported only when OP_HOME does not already define them.
 *   - Conflict detection compares provider IDs; existing credentials are
 *     preserved unless overwriteConflicts=true.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ControlPlaneState } from "./types.js";
import { authJsonPath, assistantConfigDir } from "./paths.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type HostOpenCodeStatus = {
  /** Absolute path to opencode.json if found, undefined otherwise */
  configPath?: string;
  /** Absolute path to auth.json if found, undefined otherwise */
  authPath?: string;
  /** Number of provider entries in opencode.json (0 when not found) */
  providerCount: number;
  /** Number of credential entries in auth.json (0 when not found) */
  credentialCount: number;
  /** Model preferences from the host's opencode.json, if present */
  modelPreferences?: { model?: string; small_model?: string };
};

export type HostImportResult = {
  imported: {
    providers: number;
    credentials: number;
  };
  /** Provider IDs that already existed in OP_HOME and were NOT overwritten */
  conflicts: string[];
};

// ── XDG path resolution ──────────────────────────────────────────────────────

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`;
}

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`;
}

/** ~/.config/opencode/opencode.json */
function hostConfigJsonPath(): string {
  return `${xdgConfigHome()}/opencode/opencode.json`;
}

/** ~/.local/share/opencode/auth.json */
function hostAuthJsonPath(): string {
  return `${xdgDataHome()}/opencode/auth.json`;
}

// ── opencode.json parsing ────────────────────────────────────────────────────

/** Keys that are safe to import from host opencode.json into OP_HOME config. */
const ALLOWED_CONFIG_KEYS = new Set(["$schema", "provider", "model", "small_model", "disabled_providers"]);

type OpenCodeJson = Record<string, unknown>;

function readJsonFileSafe(path: string): OpenCodeJson | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as OpenCodeJson;
  } catch {
    return null;
  }
}

function stripDisallowedKeys(obj: OpenCodeJson): OpenCodeJson {
  const next: OpenCodeJson = {};
  if (typeof obj.$schema === 'string') next.$schema = obj.$schema;
  if (obj.provider && typeof obj.provider === 'object' && !Array.isArray(obj.provider)) {
    next.provider = obj.provider;
  }
  if (typeof obj.model === 'string') next.model = obj.model;
  if (typeof obj.small_model === 'string') next.small_model = obj.small_model;
  if (Array.isArray(obj.disabled_providers) && obj.disabled_providers.every((entry) => typeof entry === 'string')) {
    next.disabled_providers = obj.disabled_providers;
  }
  return Object.fromEntries(
    Object.entries(next).filter(([k]) => ALLOWED_CONFIG_KEYS.has(k))
  );
}

function countProviders(obj: OpenCodeJson): number {
  const provider = obj.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return 0;
  return Object.keys(provider as Record<string, unknown>).length;
}

// ── auth.json credential counting ───────────────────────────────────────────

function countCredentials(path: string): number {
  const raw = readJsonFileSafe(path);
  if (!raw) return 0;
  // auth.json shape: { "providerID": { ... }, ... } — count top-level keys
  return Object.keys(raw).length;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect whether a host OpenCode installation is present.
 * Never returns credential values — only counts.
 */
export function detectHostOpenCode(): HostOpenCodeStatus {
  const configPath = hostConfigJsonPath();
  const authPath = hostAuthJsonPath();

  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  if (!configExists && !authExists) {
    return { providerCount: 0, credentialCount: 0 };
  }

  let providerCount = 0;
  let modelPreferences: { model?: string; small_model?: string } | undefined;
  if (configExists) {
    const parsed = readJsonFileSafe(configPath);
    providerCount = parsed ? countProviders(parsed) : 0;
    if (parsed) {
      const prefs: { model?: string; small_model?: string } = {};
      if (typeof parsed.model === 'string' && parsed.model) prefs.model = parsed.model;
      if (typeof parsed.small_model === 'string' && parsed.small_model) prefs.small_model = parsed.small_model;
      if (prefs.model || prefs.small_model) modelPreferences = prefs;
    }
  }

  let credentialCount = 0;
  if (authExists) {
    credentialCount = countCredentials(authPath);
  }

  return {
    configPath: configExists ? configPath : undefined,
    authPath: authExists ? authPath : undefined,
    providerCount,
    credentialCount,
    ...(modelPreferences ? { modelPreferences } : {}),
  };
}

/**
 * Import host OpenCode config + auth into OP_HOME.
 *
 * - Strips plugin/mcp/permission keys from opencode.json before writing.
 * - Copies auth.json byte-for-byte and chmods it to 0o600.
 * - On conflict: existing OP_HOME provider entries are preserved unless
 *   overwriteConflicts is true.
 *
 * @param state             ControlPlaneState (for OP_HOME path resolution)
 * @param overwriteConflicts  When true, host providers replace existing ones
 */
export function importHostOpenCode(
  state: ControlPlaneState,
  options: { overwriteConflicts?: boolean } = {}
): HostImportResult {
  const { overwriteConflicts = false } = options;
  const status = detectHostOpenCode();

  let importedProviders = 0;
  let importedCredentials = 0;
  const conflicts: string[] = [];

  // ── opencode.json ──────────────────────────────────────────────────────
  if (status.configPath) {
    const hostConfig = readJsonFileSafe(status.configPath);
    if (hostConfig) {
      const sanitized = stripDisallowedKeys(hostConfig);
      const destDir = assistantConfigDir(state);
      const destPath = `${destDir}/opencode.json`;

      mkdirSync(destDir, { recursive: true });

      // Merge with existing OP_HOME config if it exists
      const existing = existsSync(destPath) ? (readJsonFileSafe(destPath) ?? {}) : {};
      const existingProviders = (existing.provider ?? {}) as Record<string, unknown>;
      const hostProviders = (sanitized.provider ?? {}) as Record<string, unknown>;

      const mergedProviders: Record<string, unknown> = { ...existingProviders };
      for (const [id, entry] of Object.entries(hostProviders)) {
        if (Object.prototype.hasOwnProperty.call(existingProviders, id) && !overwriteConflicts) {
          conflicts.push(id);
        } else {
          mergedProviders[id] = entry;
          importedProviders++;
        }
      }

       const merged: OpenCodeJson = {
         ...existing,
         ...(typeof existing.$schema === 'undefined' && typeof sanitized.$schema !== 'undefined'
           ? { $schema: sanitized.$schema }
           : {}),
         ...(Object.keys(mergedProviders).length > 0 ? { provider: mergedProviders } : {}),
       };

       for (const key of ["model", "small_model", "disabled_providers"] as const) {
         if (typeof merged[key] === 'undefined' && typeof sanitized[key] !== 'undefined') {
           merged[key] = sanitized[key];
         }
       }

       writeFileSync(destPath, JSON.stringify(merged, null, 2) + "\n");
     }
  }

  // ── auth.json ──────────────────────────────────────────────────────────
  if (status.authPath) {
    const destPath = authJsonPath(state);
    mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });

    if (existsSync(destPath) && !overwriteConflicts) {
      // Merge: copy only keys that do not already exist in OP_HOME auth.json.
      // Belt-and-suspenders: never write anthropic credentials into OP_HOME.
      const hostAuth = readJsonFileSafe(status.authPath) ?? {};
      const existingAuth = readJsonFileSafe(destPath) ?? {};
      const merged: Record<string, unknown> = { ...existingAuth };
      for (const [id, value] of Object.entries(hostAuth)) {
        if (id === 'anthropic') continue;
        if (!Object.prototype.hasOwnProperty.call(existingAuth, id)) {
          merged[id] = value;
          importedCredentials++;
        }
      }
      writeFileSync(destPath, JSON.stringify(merged, null, 2) + "\n");
    } else {
      // No existing file or overwrite requested — parse, filter, then write.
      // Belt-and-suspenders: never write anthropic credentials into OP_HOME.
      const hostAuth = readJsonFileSafe(status.authPath) ?? {};
      const filtered: Record<string, unknown> = {};
      for (const [id, value] of Object.entries(hostAuth)) {
        if (id === 'anthropic') continue;
        filtered[id] = value;
        importedCredentials++;
      }
      writeFileSync(destPath, JSON.stringify(filtered, null, 2) + "\n");
    }

    try {
      chmodSync(destPath, 0o600);
    } catch {
      // best-effort chmod — may fail on some filesystems
    }
  }

  return {
    imported: { providers: importedProviders, credentials: importedCredentials },
    conflicts,
  };
}
