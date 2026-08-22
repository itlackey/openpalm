/**
 * Host ↔ Assistant AKM bundle wiring (control-plane logic — lives in lib).
 *
 * The assistant config ALWAYS has a `host-akm` secondary bundle pointing at
 * /host-stash (written once at install, never removed). The compose bind-mount
 * controls what actually lands at /host-stash: the real ~/akm when sharing is
 * enabled, an empty dir when disabled. That DIRECTORY is the entirety of host
 * sharing — OpenPalm never reads the host's own akm config or CLI (see
 * host-akm-sharing.ts for what importing it cost).
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
 *    retired 0.8 keys stripped, primary /stash bundle and the read-only
 *    /system-stash bundle present.
 *  - Atomic 0600 writes.
 *  - The OpenPalm config is parse-tolerant (we own it: corrupt → start from {}).
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import { PRIMARY_BUNDLE_ID, SYSTEM_BUNDLE_ID, stripRetiredAkmKeys } from "./setup.js";
import type { ControlPlaneState } from "./types.js";

/** Bundle id added to the OpenPalm/container config (points at /host-stash). */
export const HOST_SOURCE_NAME = "host-akm";

/**
 * The release-shipped skills bundle entry, defined once so every writer of the
 * assistant's akm config agrees byte-for-byte and none of them churns the file.
 */
const SYSTEM_BUNDLE = { path: "/system-stash", writable: false, enabled: true } as const;

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
  // primary /stash bundle and the read-only system bundle. Normalize the write
  // so the file is always loadable (mirrors persistAkmConfig in setup.ts).
  stripRetiredAkmKeys(updated);
  updated.configVersion = "0.9.0";
  const bundles = updated.bundles as Record<string, unknown>;
  bundles[PRIMARY_BUNDLE_ID] = {
    ...((bundles[PRIMARY_BUNDLE_ID] as Record<string, unknown> | undefined) ?? {}),
    path: "/stash",
    writable: true,
  };
  bundles[SYSTEM_BUNDLE_ID] = {
    ...((bundles[SYSTEM_BUNDLE_ID] as Record<string, unknown> | undefined) ?? {}),
    ...SYSTEM_BUNDLE,
  };
  if (typeof updated.defaultBundle !== "string") updated.defaultBundle = PRIMARY_BUNDLE_ID;
  writeFileAtomic(configPath, JSON.stringify(updated, null, 2), 0o600);
}

/**
 * Register the release-shipped skills bundle in an EXISTING assistant akm
 * config. Returns whether the file changed.
 *
 * The two writers that pin it (`persistAkmConfig`, `addHostStashToOpenpalmConfig`)
 * run at setup and install; neither runs on an upgrade. Without this, a home
 * that upgrades into the `knowledge/skills/` → `system/skills/` move gets the
 * `:ro` `/system-stash` mount but no bundle entry pointing at it — akm never
 * walks the directory, and the shipped skills the migration just removed from
 * the stash are gone from the assistant entirely. Swept on the lifecycle pass,
 * beside the retired-key strip, for the same "an upgraded install heals itself"
 * reason.
 *
 * Deliberately narrow, like its neighbour: it upserts one bundle by id and
 * writes only when that actually changed. It never touches `defaultBundle`,
 * `defaultWriteTarget`, or any other entry.
 */
export function ensureSystemBundle(state: ControlPlaneState): boolean {
  const configPath = openpalmConfigPath(state);
  if (!existsSync(configPath)) return false;
  let config: AkmConfigObject;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    config = parsed as AkmConfigObject;
  } catch {
    // Unparseable: leave it alone, same as stripRetiredKeysAt. akm reports the
    // parse error clearly on its own and rewriting would destroy the operator's
    // file.
    return false;
  }
  // Compare the ENTRY, not the file bytes: the writers here disagree about a
  // trailing newline, so a byte comparison would make this and
  // stripRetiredKeysAt rewrite the file past each other on every lifecycle pass.
  const bundles =
    config.bundles && typeof config.bundles === "object" && !Array.isArray(config.bundles)
      ? (config.bundles as Record<string, unknown>)
      : {};
  const current = bundles[SYSTEM_BUNDLE_ID];
  if (
    current &&
    typeof current === "object" &&
    (current as Record<string, unknown>).path === SYSTEM_BUNDLE.path &&
    (current as Record<string, unknown>).writable === SYSTEM_BUNDLE.writable &&
    (current as Record<string, unknown>).enabled === SYSTEM_BUNDLE.enabled
  ) {
    return false;
  }
  const updated = upsertBundle(config, SYSTEM_BUNDLE_ID, SYSTEM_BUNDLE);
  assertNoDefaultEscalation(updated, config);
  writeFileAtomic(configPath, `${JSON.stringify(updated, null, 2)}\n`, 0o600);
  return true;
}

/**
 * Strip retired 0.8 keys from an EXISTING assistant akm config so the pinned
 * akm-cli can still load it after an upgrade.
 *
 * `stripRetiredAkmKeys` already runs on every OpenPalm WRITE of this file —
 * but the only writers are the setup wizard (`persistAkmConfig`) and install
 * (`addHostStashToOpenpalmConfig`). Neither runs on an upgrade, so a config
 * written before akm 0.9 keeps its retired keys forever, and the newer CLI in
 * the upgraded image refuses the whole file:
 *
 *   Invalid config at /etc/akm/config.json:
 *     - stashDir: stashDir is retired in 0.9; the stash path now comes from
 *       `bundles`.
 *
 * Every `akm` invocation in the assistant then fails with INVALID_CONFIG_FILE
 * and the UI reports AKM metrics as unavailable, with nothing naming the
 * cause. Swept on the lifecycle pass instead, beside the retired stack.env
 * keys, so an upgraded install heals itself.
 *
 * Deliberately narrow: it removes retired keys and stamps `configVersion`, and
 * writes ONLY when one of those actually changed. It does not reshape bundles
 * or defaults — this runs on every lifecycle action against a file the
 * operator owns, so it must not rewrite anything it was not asked to.
 */
export function stripRetiredAkmConfigKeys(state: ControlPlaneState): boolean {
  // BOTH akm configs, not just the assistant's. Paperclip runs its own akm
  // against `config/paperclip/akm/config.json` (services.compose.yml mounts it
  // at /etc/akm), seeded once from the skeleton and never rewritten — so it
  // drifts exactly like the assistant's did, with the same total failure: the
  // newer CLI rejects the whole file and every akm call in that container
  // dies. Sweeping only one of the two was half a fix.
  let changed = false;
  for (const configPath of [
    openpalmConfigPath(state),
    join(state.configDir, "paperclip", "akm", "config.json"),
  ]) {
    if (stripRetiredKeysAt(configPath)) changed = true;
  }
  return changed;
}

function stripRetiredKeysAt(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  const before = readFileSync(configPath, "utf-8");
  let config: AkmConfigObject;
  try {
    const parsed: unknown = JSON.parse(before);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    config = parsed as AkmConfigObject;
  } catch {
    // Unparseable: leave it alone. Rewriting would destroy whatever the
    // operator has, and akm reports a parse error clearly on its own.
    return false;
  }
  stripRetiredAkmKeys(config);
  config.configVersion = "0.9.0";
  const after = `${JSON.stringify(config, null, 2)}\n`;
  if (after === before) return false;
  writeFileAtomic(configPath, after, 0o600);
  return true;
}

/**
 * Copy the host's akm engine/embedding configuration into the assistant's.
 *
 * MANUAL ONLY. Nothing calls this on install, on upgrade, or as a side effect
 * of any toggle — it runs when an operator explicitly asks for it, the same
 * shape as importing host OpenCode providers. That distinction is the whole
 * fix for how this behaved before: it used to fire automatically when host
 * STASH sharing was enabled, so an operator who wanted a shared knowledge
 * directory silently got the host's engine config as well. When the host ran a
 * newer akm than the image, those keys were ones the container's CLI could not
 * parse, and every akm call in the assistant died with INVALID_CONFIG_FILE and
 * nothing naming the cause. The caller validates the result against the
 * running assistant and rolls back if it cannot load — see the import route.
 *
 * Reads the personal host config READ-ONLY; never writes back to the host.
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
export function importHostAkmConfig(
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


/** The host's own akm config path (read-only, never written). */
export function hostAkmConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(home, ".config", "akm", "config.json");
}

export type HostAkmConfigStatus = {
  /** Absolute path, present so the UI can show the operator what it read. */
  configPath: string;
  /** Absent or unparseable host config. */
  available: boolean;
  /** Named engines the host has configured. */
  engineCount: number;
  /** Whether the host config carries a top-level embedding connection. */
  hasEmbedding: boolean;
};

/**
 * What an import would find on the host — the counterpart to
 * `detectHostOpenCode`, so the AKM import affordance can say what it will
 * bring over before the operator commits to it.
 */
export function detectHostAkmConfig(): HostAkmConfigStatus {
  const configPath = hostAkmConfigPath();
  const host = readHostConfigBestEffort(configPath);
  if (!host) return { configPath, available: false, engineCount: 0, hasEmbedding: false };
  const engines = host.engines;
  const engineCount =
    engines && typeof engines === "object" && !Array.isArray(engines)
      ? Object.keys(engines as Record<string, unknown>).length
      : 0;
  const embedding = host.embedding;
  return {
    configPath,
    available: true,
    engineCount,
    hasEmbedding: Boolean(embedding && typeof embedding === "object"),
  };
}
