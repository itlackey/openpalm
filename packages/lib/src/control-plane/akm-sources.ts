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
 *    retired 0.8 keys stripped, primary /stash bundle present.
 *  - Atomic 0600 writes.
 *  - The OpenPalm config is parse-tolerant (we own it: corrupt → start from {}).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import { PRIMARY_BUNDLE_ID, stripRetiredAkmKeys } from "./setup.js";
import type { ControlPlaneState } from "./types.js";

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
  const configPath = openpalmConfigPath(state);
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
