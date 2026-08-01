/**
 * Host ↔ Assistant AKM source wiring (control-plane logic — lives in lib).
 *
 * The assistant config ALWAYS has a `host-akm` secondary bundle pointing at
 * /host-stash (written once at install, never removed). The compose bind-mount
 * controls what actually lands at /host-stash: the real ~/akm when sharing is
 * enabled, an empty dir when disabled. Profile import is best-effort — missing
 * or corrupt host config is logged and skipped, never an error.
 *
 * Invariants (enforced + unit-tested):
 *  - Only ever appends/updates the named bundle.
 *  - NEVER changes `defaultBundle` or `defaultWriteTarget`.
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

/** A filesystem bundle entry as akm 0.9 persists it in config.bundles. */
type FilesystemBundleEntry = {
  path: string;
  writable: boolean;
  enabled: boolean;
};

type AkmConfigObject = Record<string, unknown>;

function isObject(value: unknown): value is AkmConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 * Upsert the named filesystem bundle. Idempotent and never changes either
 * default target.
 */
function upsertBundle(config: AkmConfigObject, entry: FilesystemBundleEntry): AkmConfigObject {
  const bundles = isObject(config.bundles) ? config.bundles : {};
  const existing = isObject(bundles[HOST_SOURCE_NAME]) ? bundles[HOST_SOURCE_NAME] : {};
  return {
    ...config,
    configVersion: "0.9.0",
    bundles: { ...bundles, [HOST_SOURCE_NAME]: { ...existing, ...entry } },
  };
}

function assertNoPrimaryEscalation(entry: FilesystemBundleEntry): void {
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
  const entry: FilesystemBundleEntry = {
    path: "/host-stash",
    writable,
    enabled: true,
  };
  assertNoPrimaryEscalation(entry);
  const config = readConfigTolerant(configPath);
  const base = {
    ...config,
    configVersion: "0.9.0",
    bundles: isObject(config.bundles)
      ? config.bundles
      : { stash: { path: "/stash", writable: true } },
    defaultBundle: typeof config.defaultBundle === "string" ? config.defaultBundle : "stash",
    semanticSearchMode: config.semanticSearchMode ?? "auto",
  };
  const updated = upsertBundle(base, entry);
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
 * Writes the canonical akm shape (engines + defaults + embedding).
 * NEVER touches bundles or registries.
 */
export function importHostProfiles(
  state: ControlPlaneState,
  hostConfigPath: string,
): { imported: string[] } {
  const host = readHostConfigBestEffort(hostConfigPath);
  if (!host) return { imported: [] };
  const hostEngines = (host.engines as Record<string, unknown> | undefined) ?? {};
  const hostDefaults = (host.defaults as Record<string, unknown> | undefined) ?? {};

  const opPath = openpalmConfigPath(state);
  const op = readConfigTolerant(opPath);
  const opEngines = (op.engines as Record<string, unknown> | undefined) ?? {};
  const opDefaults = (op.defaults as Record<string, unknown> | undefined) ?? {};

  const imported: string[] = [];

  // ADDITIVE MERGE — existing OpenPalm values always win; the host fills only
  // gaps. Never overwrite a profile, default selection, or embedding field the
  // operator/wizard already set. `imported` lists what was actually added.
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

  const mergedEngines = { ...hostEngines, ...opEngines };
  if (Object.keys(mergedEngines).length > Object.keys(opEngines).length) imported.push("engines");
  for (const key of ["engine", "llmEngine", "improveStrategy"] as const) {
    if (typeof hostDefaults[key] === "string" && typeof opDefaults[key] !== "string") {
      opDefaults[key] = hostDefaults[key];
      imported.push(`defaults.${key}`);
    }
  }

  const hostImprove = isObj(host.improve) ? host.improve : {};
  const opImprove = isObj(op.improve) ? op.improve : {};
  const hostStrategies = isObj(hostImprove.strategies) ? hostImprove.strategies : {};
  const opStrategies = isObj(opImprove.strategies) ? opImprove.strategies : {};
  const mergedStrategies = { ...hostStrategies, ...opStrategies };
  const improve =
    Object.keys(mergedStrategies).length > 0
      ? { ...hostImprove, ...opImprove, strategies: mergedStrategies }
      : opImprove;
  if (Object.keys(mergedStrategies).length > Object.keys(opStrategies).length) imported.push("improve.strategies");

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

  const updated: AkmConfigObject = {
    ...op,
    configVersion: "0.9.0",
    engines: mergedEngines,
    defaults: opDefaults,
    ...(Object.keys(improve).length > 0 ? { improve } : {}),
  };
  if (embedding !== undefined) updated.embedding = embedding;
  writeFileAtomic(opPath, JSON.stringify(updated, null, 2), 0o600);
  return { imported };
}
