/**
 * Host ↔ Assistant AKM bundle wiring (control-plane logic — lives in lib).
 *
 * The assistant config ALWAYS has a `host-akm` secondary bundle pointing at
 * /host-stash (written once at install, never removed). The compose bind-mount
 * controls what actually lands at /host-stash: the real ~/akm when sharing is
 * enabled, an empty dir when disabled. Engine import is best-effort — missing
 * or corrupt host config is logged and skipped, never an error.
 *
 * akm >= 0.9.0: sources are a `bundles` map (`bundles.<id>` entries) instead
 * of the retired `sources[]` array, and LLM/agent execution config lives in
 * `engines` + `defaults.engine`/`defaults.llmEngine` instead of the retired
 * `profiles.*` + `defaults.llm`/`defaults.agent` keys.
 *
 * Invariants (enforced + unit-tested):
 *  - Only ever upserts a NAMED bundle entry (idempotent upsert by id).
 *  - NEVER makes `host-akm` the default: `defaultBundle` is only ever pinned
 *    to the primary openpalm bundle (and only when unset, mirroring
 *    persistAkmConfig). NEVER sets `defaultWriteTarget`.
 *  - Every write is a loadable akm 0.9.0 config: configVersion stamped,
 *    retired 0.8 keys stripped, primary /stash bundle present.
 *  - Atomic 0600 writes.
 *  - The OpenPalm config is parse-tolerant (we own it: corrupt → start from {}).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import { createLogger } from "../logger.js";
import { PRIMARY_BUNDLE_ID, stripRetiredAkmKeys } from "./setup.js";
import type { ControlPlaneState } from "./types.js";

const logger = createLogger("akm-sources");

/** Bundle id added to the OpenPalm/container config (points at /host-stash). */
export const HOST_SOURCE_NAME = "host-akm";

/** A filesystem bundle entry as akm >= 0.9.0 persists it in config.bundles. */
type FilesystemBundleEntry = {
  path: string;
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
    logger.warn("host akm config is not valid JSON — skipping engine import", { configPath });
    return null;
  }
}

/**
 * Upsert a named bundle entry into `config.bundles` by id. Idempotent.
 * NEVER touches `defaultBundle` or `defaultWriteTarget`.
 */
function upsertBundle(
  config: AkmConfigObject,
  id: string,
  entry: FilesystemBundleEntry,
): AkmConfigObject {
  const bundles =
    config.bundles && typeof config.bundles === "object" && !Array.isArray(config.bundles)
      ? { ...(config.bundles as Record<string, unknown>) }
      : {};
  const existing =
    bundles[id] && typeof bundles[id] === "object" && !Array.isArray(bundles[id])
      ? (bundles[id] as Record<string, unknown>)
      : {};
  // Preserve any unrelated fields the user set (e.g. components), override ours.
  bundles[id] = { ...existing, ...entry };
  return { ...config, bundles };
}

function assertNoDefaultEscalation(config: AkmConfigObject, before: AkmConfigObject): void {
  // Defense in depth: a secondary bundle that became the default would change
  // the write target. This writer must never introduce or change those keys.
  if (config.defaultBundle !== before.defaultBundle || config.defaultWriteTarget !== before.defaultWriteTarget) {
    throw new Error("akm-sources: refusing to change defaultBundle/defaultWriteTarget.");
  }
}

function openpalmConfigPath(state: ControlPlaneState): string {
  return join(state.configDir, "akm", "config.json");
}

/**
 * Container/OpenPalm side: add the personal stash (mounted at /host-stash) as a
 * secondary bundle. Parse-tolerant (we own this config). Writable by default so
 * the assistant can contribute back via an explicit `--bundle host-akm` (or
 * `--target host-akm` on the write commands that kept `--target`).
 */
export function addHostStashToOpenpalmConfig(state: ControlPlaneState, writable = true): void {
  const configPath = openpalmConfigPath(state);
  const entry: FilesystemBundleEntry = {
    path: "/host-stash",
    writable,
    enabled: true,
  };
  const config = readConfigTolerant(configPath);
  const updated = upsertBundle(config, HOST_SOURCE_NAME, entry);
  // The host-akm upsert itself must never touch the default write target.
  assertNoDefaultEscalation(updated, config);
  // akm 0.9.0 refuses to load a config without configVersion "0.9.0" or with
  // retired 0.8 keys, and a config whose ONLY bundle is host-akm has lost the
  // primary /stash bundle. Normalize the write so the file is always loadable
  // (mirrors persistAkmConfig in setup.ts).
  stripRetiredAkmKeys(updated);
  updated.configVersion = "0.9.0";
  const bundles = updated.bundles as Record<string, unknown>;
  bundles[PRIMARY_BUNDLE_ID] = {
    ...((bundles[PRIMARY_BUNDLE_ID] as Record<string, unknown> | undefined) ?? {}),
    path: "/stash",
    writable: true,
  };
  if (typeof updated.defaultBundle !== "string") updated.defaultBundle = PRIMARY_BUNDLE_ID;
  writeFileAtomic(configPath, JSON.stringify(updated, null, 2), 0o600);
}

/**
 * Best-effort import of the host's engine/embedding config into the OpenPalm
 * akm config. Reads the personal host config READ-ONLY; never writes back to
 * the host.
 *
 * ADDITIVE MERGE: existing OpenPalm values ALWAYS win — the host only fills
 * gaps. Returns `{ imported: [] }` when the host config is absent or
 * unreadable (never throws — engine import is always optional).
 *
 * Writes the canonical akm 0.9.0 shape (engines + defaults.* + embedding +
 * improve.strategies), stamping configVersion and stripping the retired 0.8
 * keys so the persisted file is always loadable. NEVER touches `bundles`,
 * `defaultBundle`, `registries`, or `defaultWriteTarget`. A host config still
 * in the retired
 * 0.8 `profiles` shape is skipped — akm itself refuses to load it, so there
 * is nothing trustworthy to import.
 */
export function importHostProfiles(
  state: ControlPlaneState,
  hostConfigPath: string,
): { imported: string[] } {
  const host = readHostConfigBestEffort(hostConfigPath);
  if (!host) return { imported: [] };

  const opPath = openpalmConfigPath(state);
  const op = readConfigTolerant(opPath);

  const imported: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

  // ADDITIVE MERGE — existing OpenPalm values always win; the host fills only
  // gaps. Never overwrite an engine, default selection, strategy, or embedding
  // field the operator/wizard already set. `imported` lists what was added.

  // engines (akm 0.9.0 config-schema EnginesSchema).
  const opEngines = isObj(op.engines) ? (op.engines as Record<string, unknown>) : {};
  let engines = opEngines;
  if (isObj(host.engines)) {
    // host first, existing last → existing wins; only host-only engine names are added.
    const merged: Record<string, unknown> = { ...(host.engines as Record<string, unknown>), ...opEngines };
    if (Object.keys(merged).length > Object.keys(opEngines).length) {
      engines = merged;
      imported.push("engines");
    }
  }

  // defaults.engine / defaults.llmEngine / defaults.improveStrategy — only
  // adopt a host selection when OpenPalm has none.
  const hostDefaults = isObj(host.defaults) ? (host.defaults as Record<string, unknown>) : {};
  const opDefaults = isObj(op.defaults) ? { ...(op.defaults as Record<string, unknown>) } : {};
  for (const key of ["engine", "llmEngine", "improveStrategy"] as const) {
    if (typeof hostDefaults[key] === "string" && typeof opDefaults[key] !== "string") {
      opDefaults[key] = hostDefaults[key];
      imported.push(`defaults.${key}`);
    }
  }

  // improve.strategies — additive by strategy name.
  const hostImprove = isObj(host.improve) ? (host.improve as Record<string, unknown>) : {};
  const opImprove = isObj(op.improve) ? { ...(op.improve as Record<string, unknown>) } : {};
  let improveChanged = false;
  if (isObj(hostImprove.strategies)) {
    const opStrategies = isObj(opImprove.strategies) ? (opImprove.strategies as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...(hostImprove.strategies as Record<string, unknown>), ...opStrategies };
    if (Object.keys(merged).length > Object.keys(opStrategies).length) {
      opImprove.strategies = merged;
      improveChanged = true;
      imported.push("improve.strategies");
    }
  }

  // Top-level embedding connection. Per-field additive: existing OpenPalm
  // fields win; host fills only missing fields.
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

  const updated: AkmConfigObject = { ...op, engines, defaults: opDefaults };
  if (improveChanged) updated.improve = opImprove;
  if (embedding !== undefined) updated.embedding = embedding;
  // akm 0.9.0 hard-rejects the retired 0.8 keys and requires configVersion —
  // never persist a config akm refuses to load (same normalization as
  // persistAkmConfig in setup.ts).
  stripRetiredAkmKeys(updated);
  updated.configVersion = "0.9.0";
  writeFileAtomic(opPath, JSON.stringify(updated, null, 2), 0o600);
  return { imported };
}
