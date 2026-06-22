/**
 * Host ↔ Assistant AKM source wiring (control-plane logic — lives in lib).
 *
 * The assistant config ALWAYS has a `host-akm` secondary source pointing at
 * /host-stash (written once at install, never removed). The compose bind-mount
 * controls what actually lands at /host-stash: the real ~/akm when sharing is
 * enabled, an empty dir when disabled. Profile import is best-effort — missing
 * or corrupt host config is logged and skipped, never an error.
 *
 * Invariants (enforced + unit-tested):
 *  - Only ever appends/updates a NAMED source (idempotent upsert by name).
 *  - NEVER sets `primary`, NEVER sets `defaultWriteTarget`, NEVER sets `stashDir`.
 *  - Atomic 0600 writes.
 *  - The OpenPalm config is parse-tolerant (we own it: corrupt → start from {}).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import { createLogger } from "../logger.js";
import type { ControlPlaneState } from "./types.js";

const logger = createLogger("akm-sources");

/** Source entry name added to the OpenPalm/container config (points at /host-stash). */
export const HOST_SOURCE_NAME = "host-akm";

/** A filesystem source entry as akm persists it in config.sources[]. */
type FilesystemSourceEntry = {
  type: "filesystem";
  path: string;
  name: string;
  writable: boolean;
  enabled: boolean;
};

type AkmConfigObject = Record<string, unknown>;

function readConfigTolerant(configPath: string): AkmConfigObject {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as AkmConfigObject) : {};
  } catch {
    // We own the OpenPalm config — a corrupt file is recoverable by rewriting.
    return {};
  }
}

function readHostConfigBestEffort(configPath: string): AkmConfigObject | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as AkmConfigObject) : null;
  } catch {
    logger.warn("host akm config is not valid JSON — skipping profile import", { configPath });
    return null;
  }
}

/**
 * Upsert a named filesystem source into `config.sources[]` by name. Idempotent.
 * NEVER touches `primary`, `defaultWriteTarget`, or `stashDir`.
 */
function upsertSource(config: AkmConfigObject, entry: FilesystemSourceEntry): AkmConfigObject {
  const sources = Array.isArray(config.sources) ? [...(config.sources as unknown[])] : [];
  const idx = sources.findIndex(
    (s) => s && typeof s === "object" && (s as Record<string, unknown>).name === entry.name,
  );
  if (idx >= 0) {
    // Preserve any unrelated fields the user set (e.g. options), override ours.
    sources[idx] = { ...(sources[idx] as Record<string, unknown>), ...entry };
  } else {
    sources.push(entry);
  }
  return { ...config, sources };
}

function removeSource(config: AkmConfigObject, name: string): AkmConfigObject {
  if (!Array.isArray(config.sources)) return config;
  const sources = (config.sources as unknown[]).filter(
    (s) => !(s && typeof s === "object" && (s as Record<string, unknown>).name === name),
  );
  return { ...config, sources };
}

function assertNoPrimaryEscalation(entry: FilesystemSourceEntry): void {
  // Defense in depth: the type forbids `primary`, but assert at runtime too —
  // a secondary that became primary would change the write target.
  if ((entry as Record<string, unknown>).primary !== undefined) {
    throw new Error("akm-sources: refusing to write a source entry carrying `primary`.");
  }
}

function openpalmConfigPath(state: ControlPlaneState): string {
  return join(state.configDir, "akm", "config.json");
}

/**
 * Container/OpenPalm side: add the personal stash (mounted at /host-stash) as a
 * secondary source. Parse-tolerant (we own this config). Writable by default so
 * the assistant can contribute back via an explicit `--target host-akm`.
 */
export function addHostStashToOpenpalmConfig(state: ControlPlaneState, writable = true): void {
  const configPath = openpalmConfigPath(state);
  const entry: FilesystemSourceEntry = {
    type: "filesystem",
    path: "/host-stash",
    name: HOST_SOURCE_NAME,
    writable,
    enabled: true,
  };
  assertNoPrimaryEscalation(entry);
  const config = readConfigTolerant(configPath);
  const updated = upsertSource(config, entry);
  writeFileAtomic(configPath, JSON.stringify(updated, null, 2), 0o600);
}

/**
 * Best-effort import of the host's LLM/agent profiles into the OpenPalm akm config.
 * Reads the personal host config READ-ONLY; never writes back to the host.
 *
 * ADDITIVE MERGE: existing OpenPalm values ALWAYS win — the host only fills gaps.
 * Returns `{ imported: [] }` when the host config is absent or unreadable (never
 * throws — profile import is always optional).
 *
 * Writes the canonical akm shape (profiles.* + defaults.* + embedding).
 * NEVER touches `sources`, `stashDir`, `registries`, or `installed`.
 */
export function importHostProfiles(
  state: ControlPlaneState,
  hostConfigPath: string,
): { imported: string[] } {
  const host = readHostConfigBestEffort(hostConfigPath);
  if (!host) return { imported: [] };
  const hostProfiles = (host.profiles as Record<string, unknown> | undefined) ?? {};
  const hostDefaults = (host.defaults as Record<string, unknown> | undefined) ?? {};

  const opPath = openpalmConfigPath(state);
  const op = readConfigTolerant(opPath);
  const opProfiles = (op.profiles as Record<string, unknown> | undefined) ?? {};
  const opDefaults = (op.defaults as Record<string, unknown> | undefined) ?? {};

  const imported: string[] = [];

  // ADDITIVE MERGE — existing OpenPalm values always win; the host fills only
  // gaps. Never overwrite a profile, default selection, or embedding field the
  // operator/wizard already set. `imported` lists what was actually added.
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

  // All three profile namespaces akm supports (config-schema.ts ProfilesSchema).
  for (const ns of ["llm", "agent", "improve"] as const) {
    if (isObj(hostProfiles[ns])) {
      const existing = isObj(opProfiles[ns]) ? (opProfiles[ns] as Record<string, unknown>) : {};
      // host first, existing last → existing wins; only host-only profile names are added.
      const merged: Record<string, unknown> = { ...(hostProfiles[ns] as Record<string, unknown>), ...existing };
      const added = Object.keys(merged).length - Object.keys(existing).length;
      opProfiles[ns] = merged;
      if (added > 0) imported.push(`profiles.${ns}`);
    }
    // Only adopt a host default selection when OpenPalm has none.
    if (typeof hostDefaults[ns] === "string" && typeof opDefaults[ns] !== "string") {
      opDefaults[ns] = hostDefaults[ns];
      imported.push(`defaults.${ns}`);
    }
  }

  // Top-level embedding connection (EmbeddingConnectionConfigSchema). Per-field
  // additive: existing OpenPalm fields win; host fills only missing fields.
  let embedding: Record<string, unknown> | undefined;
  if (isObj(host.embedding)) {
    const existing = isObj(op.embedding) ? (op.embedding as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...(host.embedding as Record<string, unknown>), ...existing };
    if (Object.keys(merged).length > Object.keys(existing).length) {
      embedding = merged;
      imported.push("embedding");
    }
  }

  if (imported.length === 0) return { imported };

  const updated: AkmConfigObject = { ...op, profiles: opProfiles, defaults: opDefaults };
  if (embedding !== undefined) updated.embedding = embedding;
  delete (updated as Record<string, unknown>).llm; // never persist the legacy key
  writeFileAtomic(opPath, JSON.stringify(updated, null, 2), 0o600);
  return { imported };
}
