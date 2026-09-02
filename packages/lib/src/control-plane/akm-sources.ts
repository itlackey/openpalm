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
 *  - Only ever upserts a NAMED bundle entry (idempotent upsert by id), except
 *    `reconcileDuplicateBundles`, which also REMOVES entries that duplicate the
 *    primary's directory.
 *  - NEVER makes `host-akm` the default: `defaultBundle` is only ever pinned
 *    to the primary openpalm bundle (and only when unset, mirroring
 *    persistAkmConfig). NEVER sets `defaultWriteTarget` — with ONE narrow
 *    exception: `reconcileDuplicateBundles` repoints either key at
 *    PRIMARY_BUNDLE_ID when it names an entry that sweep is removing, because
 *    the alternative is a config naming a bundle that no longer exists. See
 *    assertDefaultsOnlyRepointedToPrimary. Every other writer keeps the
 *    unconditional guard (assertNoDefaultEscalation).
 *  - Every write is a loadable akm 0.9.0 config: configVersion stamped,
 *    retired 0.8 keys stripped, primary /stash bundle and the read-only
 *    /system-stash bundle present.
 *  - Atomic 0600 writes.
 *  - The OpenPalm config is parse-tolerant (we own it: corrupt → start from {}).
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { join as joinPosix, normalize as normalizePosix } from "node:path/posix";
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
 * homeDir-based form of {@link openpalmConfigPath}, for the three sweeps below
 * that are now home-schema MIGRATIONS (home-schema.ts) rather than
 * `ControlPlaneState`-scoped writers: a migration only ever has a homeDir,
 * and `configDir` is always `${homeDir}/config` (home.ts's resolveConfigDir).
 */
function assistantAkmConfigPath(homeDir: string): string {
  return join(homeDir, "config", "akm", "config.json");
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
 * the stash are gone from the assistant entirely.
 *
 * #654: a HOME-SCHEMA MIGRATION (home-schema.ts `MIGRATIONS`), not a sweep run
 * on every apply — the shape it heals ("no bundle entry for a mount this
 * release's skills move introduced") is exactly one release transition, so it
 * belongs behind a `since` gate with its own test, run once per upgraded home,
 * rather than re-checked on every install/update/launch forever.
 *
 * Deliberately narrow, like its neighbours: it upserts one bundle by id and
 * writes only when that actually changed. It never touches `defaultBundle`,
 * `defaultWriteTarget`, or any other entry.
 */
export function ensureSystemBundle(homeDir: string): boolean {
  const configPath = assistantAkmConfigPath(homeDir);
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
 * The `root` of a bundle entry's single component, `"."` when it declares none,
 * or null when the entry's `components` map is not one akm would accept.
 *
 * akm requires EXACTLY one component per bundle (`bundleComponentConfig`
 * refuses the whole config otherwise), so anything else is a config the pinned
 * CLI will not load — resolving a content root out of it would be guesswork.
 */
function bundleComponentRoot(entry: Record<string, unknown>): string | null {
  const components = entry.components;
  if (components === undefined) return ".";
  if (!components || typeof components !== "object" || Array.isArray(components)) return null;
  const values = Object.values(components as Record<string, unknown>);
  if (values.length !== 1) return null;
  const component = values[0];
  if (!component || typeof component !== "object" || Array.isArray(component)) return null;
  const root = (component as Record<string, unknown>).root;
  if (root === undefined) return ".";
  if (typeof root !== "string" || root.trim() === "") return null;
  return root.trim();
}

/**
 * The directory a bundle entry actually contributes, compared the way a
 * duplicate-detector must: lexically normalized, with `.`/`..` segments,
 * duplicate separators and trailing slashes collapsed, so `/stash`, `/stash/`,
 * `/stash//` and `/stash/./` are one directory.
 *
 * It is the entry's `path` JOINED WITH ITS COMPONENT ROOT, not the bare `path`.
 * That is what akm enumerates: both `taskRoots` (the migration that fails) and
 * `primaryBundlePath` resolve a bundle's content root as
 * `resolve(entry.path, component.root ?? ".")`. Two entries can share
 * `path: "/stash"` and still be genuinely different roots — one at `/stash` and
 * one at `/stash/docs` — and those are NOT the collision that blocks the
 * migration. Comparing the bare `path` would delete the second one.
 *
 * POSIX semantics deliberately, on every host. These are CONTAINER mount points
 * (/stash, /system-stash, /host-stash) written into a config the container
 * consumes; this control-plane code runs on the HOST, which may be Windows,
 * where `node:path`'s platform-dependent normalize turns "/stash/" into
 * "\stash\" and leaves the trailing separator our strip does not match — so the
 * tolerant spellings above would silently stop collapsing there.
 *
 * We also deliberately do NOT resolve symlinks: on the host those container
 * paths do not exist at all, so a realpath() would either throw or hand back
 * the input unchanged — a symlink check that cannot run on the machine doing
 * the checking. A lexical comparison always runs, and it is the comparison that
 * matches the failure being fixed: the duplicate akm synthesizes for
 * AKM_BUNDLE_DIR is the same string as the primary's path.
 *
 * Returns null for anything that is not a usable path, so a malformed entry is
 * never treated as a duplicate of anything.
 */
function normalizeBundlePath(entry: Record<string, unknown>): string | null {
  const value = entry.path;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const root = bundleComponentRoot(entry);
  if (root === null) return null;
  const normalized = normalizePosix(root === "." ? trimmed : joinPosix(trimmed, root));
  // normalize() keeps a trailing separator ("/stash/./" → "/stash/"); drop it,
  // but never turn root itself into the empty string.
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/**
 * The NARROW exception to {@link assertNoDefaultEscalation}, for the one writer
 * that has to be allowed to move the default.
 *
 * `reconcileDuplicateBundles` removes bundle entries by id, and on the shape
 * this exists to fix, `defaultBundle` NAMES one of the entries being removed
 * ("stash"). Leaving it pointing at an id that no longer exists would be
 * strictly worse than the duplicate we came to clean up, so the default must
 * move with it.
 *
 * Being honest about why this is not the escalation the guard exists to stop:
 * the removed entry and PRIMARY_BUNDLE_ID point at the SAME directory (that is
 * the entire criterion for removing it), so repointing changes only which id
 * names the default — not which directory an untargeted write lands in. Any
 * other movement of these two keys still throws, and the other writers keep the
 * unconditional guard.
 */
function assertDefaultsOnlyRepointedToPrimary(
  config: AkmConfigObject,
  before: AkmConfigObject,
  removedIds: readonly string[],
): void {
  for (const key of ["defaultBundle", "defaultWriteTarget"] as const) {
    const from = before[key];
    const to = config[key];
    if (to === from) continue;
    if (typeof from === "string" && removedIds.includes(from) && to === PRIMARY_BUNDLE_ID) continue;
    throw new Error(`akm-sources: refusing to change ${key}.`);
  }
}

/**
 * Remove any OTHER bundle entry that points at the SAME directory as the
 * primary bundle, keeping PRIMARY_BUNDLE_ID. Returns whether the file changed.
 *
 * The failure: akm synthesizes a bundle for AKM_BUNDLE_DIR when no configured
 * bundle matches that path, and names it `stash`. Once that entry is persisted
 * next to OpenPalm's own `openpalm` entry — same /stash directory, two ids —
 * every durable-state migration enumerates each task file under /stash twice
 * and refuses to run:
 *
 *   {"ok": false, "error": "duplicate task migration file path: /stash/tasks/akm-improve.yml"}
 *
 * The entrypoint catches the exit 70 and boots anyway ("akm commands may fail
 * until it succeeds"), so the stack looks healthy while akm's migration is
 * permanently blocked — it fails identically on every subsequent boot, and
 * nothing surfaces it. Swept on the lifecycle pass, beside the retired-key
 * strip and the system-bundle upsert, for the same "an install heals itself"
 * reason: this file is written once at setup/install and then left alone by
 * OpenPalm, so a config that drifts has nothing else that would heal it.
 *
 * Two things DO rewrite it after install, and neither heals this: akm itself,
 * which persists the synthesized `stash` entry (that is the bug's own
 * mechanism, and why `openpalm-system` carries a `components.main.adapter`
 * block no OpenPalm writer emits), and the AKM settings PATCH route, which
 * pins the primary entry but preserves the rest of the map verbatim.
 *
 * STATUS UNDER akm >= 0.9.7 — read this before deleting the migration. akm
 * 0.9.7 fixed the root cause (akm#870) the same way this does: bundle identity
 * is the RESOLVED content root at both registration sites, so akm no longer
 * mints a second id for an already-configured directory, and `migrate` no
 * longer throws on one that already exists. That removes the recurring exit-70
 * failure, NOT the config state behind it. Verified against the shipped 0.9.6
 * on a fixture carrying the live duplicate shape: `migrate status` reports
 * `current` with no blockers, and the config is byte-identical afterwards —
 * both entries, `defaultBundle: "stash"`, and the removed entry's `registryId`
 * all still present. akm tolerates the duplicate; it does not clean it.
 *
 * So this stays, with a narrower job than it had: it is the ONLY thing that
 * removes the duplicate from a home that ran 0.9.1-0.9.5, and the only thing
 * that moves `defaultBundle`/`defaultWriteTarget` off an id akm synthesized and
 * OpenPalm does not own. It is now legacy cleanup rather than a guard against
 * active corruption — on a home that has only ever seen >= 0.9.7 it finds
 * nothing and returns false. It also still covers the case where an akm older
 * than the container pin writes this file (a rollback, or a host akm run
 * against the same config), which is exactly how the duplicate got minted.
 *
 * #654: a HOME-SCHEMA MIGRATION (home-schema.ts `MIGRATIONS`), not a sweep run
 * on every apply forever — the duplicate it cleans up is a shape older akm
 * releases wrote, i.e. exactly a release transition, so it belongs behind a
 * `since` gate with its own test rather than being re-checked on every
 * install/update/launch against a home that has long since stopped producing
 * it.
 *
 * OpenPalm keeps its OWN id. Renaming the primary to `stash` would hand the
 * bundle id akm happens to synthesize authority over the one tree a backup
 * captures as user data; the duplicate is what goes.
 *
 * Deliberately narrow, like its neighbours: it removes entries whose CONTENT
 * ROOT collides with the primary's, folds any field they carried and the
 * primary lacks onto the primary, and repoints only a default that named one
 * of them. It touches no other entry and no other key, and it is a no-op (no
 * write, returns false) when there is no duplicate.
 */
export function reconcileDuplicateBundles(homeDir: string): boolean {
  const configPath = assistantAkmConfigPath(homeDir);
  if (!existsSync(configPath)) return false;
  let config: AkmConfigObject;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    config = parsed as AkmConfigObject;
  } catch {
    // Unparseable: leave it alone, same as its neighbours. akm reports the parse
    // error clearly on its own and rewriting would destroy the operator's file.
    return false;
  }
  const bundles =
    config.bundles && typeof config.bundles === "object" && !Array.isArray(config.bundles)
      ? (config.bundles as Record<string, unknown>)
      : {};
  const primaryEntry = bundles[PRIMARY_BUNDLE_ID];
  const primary =
    primaryEntry && typeof primaryEntry === "object" && !Array.isArray(primaryEntry)
      ? (primaryEntry as Record<string, unknown>)
      : null;
  // No primary entry (or no usable content root on it) — there is nothing to be
  // a duplicate OF, and creating it belongs to install, not to this sweep.
  // `enabled: false` counts as "nothing to be a duplicate of" for the same
  // reason it does below: akm never enumerates a disabled bundle, so no other
  // entry can be a second enumeration of this one.
  if (!primary || primary.enabled === false) return false;
  const primaryPath = normalizeBundlePath(primary);
  if (!primaryPath) return false;

  // Compare the ENTRIES, not the file bytes: this shares the file with
  // stripRetiredKeysAt and ensureSystemBundle, and a byte comparison would make
  // them rewrite past each other on every lifecycle pass.
  const duplicates = Object.keys(bundles).filter((id) => {
    if (id === PRIMARY_BUNDLE_ID) return false;
    const entry = bundles[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    // A disabled bundle cannot be causing this: taskRoots opens with
    // `if (bundle.enabled === false) continue`, so it never contributes the
    // second enumeration of /stash/tasks/*.yml that blocks the migration. akm
    // documents the flag as opting a bundle out "without deleting it" — an
    // operator asked to keep-but-park it, and this sweep is not the thing that
    // overrules that.
    if ((entry as Record<string, unknown>).enabled === false) return false;
    return normalizeBundlePath(entry as Record<string, unknown>) === primaryPath;
  });
  if (duplicates.length === 0) return false;

  // Carry the removed entries' configuration onto the survivor instead of
  // dropping it. On the live shape the `stash` entry holds
  // `components: {main: {adapter: "akm"}}` and `openpalm` holds none, so a bare
  // delete would take /stash from a DECLARED adapter to auto-detection — and
  // akm probes websiteSnapshot/agentSkills/claude/opencode/dotenv/akmWorkflow/
  // akmTask/llmWiki all AHEAD of `akm`, while taskRoots skips any root whose
  // adapter is not `akm`/`akm-task`. Detection happens to still land on `akm`
  // today, so a bare delete would trade a loud failure for a silent skip the
  // first time the stash grew a `<dir>/SKILL.md` package. `registryId` would go
  // the same way. Only fields the primary does NOT already have are adopted,
  // and never the three OpenPalm owns on this entry (`path`, `writable`,
  // `enabled`) — a duplicate must not be able to flip the primary's routing.
  const nextBundles = { ...bundles };
  const survivor: Record<string, unknown> = { ...primary };
  for (const id of duplicates) {
    for (const [key, value] of Object.entries(bundles[id] as Record<string, unknown>)) {
      if (key === "path" || key === "writable" || key === "enabled") continue;
      if (key in survivor) continue;
      survivor[key] = value;
      // `components` also carries the content ROOT, and the survivor keeps the
      // PRIMARY's `path` — so a root that was written relative to a different
      // spelling of the same directory (`{path: "/", root: "stash"}` beside
      // `{path: "/stash"}`) would move the survivor off the very directory that
      // made these two duplicates. Adopt only what leaves the root where it was.
      if (normalizeBundlePath(survivor) !== primaryPath) delete survivor[key];
    }
    delete nextBundles[id];
  }
  nextBundles[PRIMARY_BUNDLE_ID] = survivor;
  const updated: AkmConfigObject = { ...config, bundles: nextBundles };
  // A default naming a bundle we just removed has to move to the primary — see
  // assertDefaultsOnlyRepointedToPrimary for why that is not an escalation.
  if (typeof config.defaultBundle === "string" && duplicates.includes(config.defaultBundle)) {
    updated.defaultBundle = PRIMARY_BUNDLE_ID;
  }
  if (typeof config.defaultWriteTarget === "string" && duplicates.includes(config.defaultWriteTarget)) {
    updated.defaultWriteTarget = PRIMARY_BUNDLE_ID;
  }
  assertDefaultsOnlyRepointedToPrimary(updated, config, duplicates);
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
 * cause.
 *
 * #654/#645: a HOME-SCHEMA MIGRATION (home-schema.ts `MIGRATIONS`), not a sweep
 * run on every apply forever. The shape it heals — a config still carrying
 * retired 0.8 keys, or a 0.12.x `profiles.llm.*` never translated into
 * `engines.*` — is exactly a release transition, so it gets a `since` gate and
 * its own test instead of asking "what do I delete?" on every install/update/
 * launch against a home that has long since been cleaned. The translation
 * itself (`translateLegacyLlmProfiles`, called from `stripRetiredAkmKeys`
 * below) is unconditional and content-based, so replaying this migration
 * after a rollback is already safe by construction: a config with no more
 * `profiles.llm.*` has nothing left to translate (#657.3).
 *
 * Deliberately narrow: it removes retired keys and stamps `configVersion`, and
 * writes ONLY when one of those actually changed. It does not reshape bundles
 * or defaults — this must not rewrite anything it was not asked to on a file
 * the operator owns.
 */
export function stripRetiredAkmConfigKeys(homeDir: string): boolean {
  // BOTH akm configs, not just the assistant's. Paperclip runs its own akm
  // against `config/paperclip/akm/config.json` (services.compose.yml mounts it
  // at /etc/akm), seeded once from the skeleton and never rewritten — so it
  // drifts exactly like the assistant's did, with the same total failure: the
  // newer CLI rejects the whole file and every akm call in that container
  // dies. Sweeping only one of the two was half a fix.
  let changed = false;
  for (const configPath of [
    assistantAkmConfigPath(homeDir),
    join(homeDir, "config", "paperclip", "akm", "config.json"),
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
 * W10, applied to the host-config import: `config/akm/config.json` is
 * CONTAINER-VIEW by contract. The setup wizard already rewrites loopback
 * provider URLs to `host.docker.internal` at the exact point they are
 * persisted for container consumption (ui setup/payload.ts,
 * toContainerReachableUrl — same regex), and akm-user-env.ts translates that
 * hostname BACK to loopback whenever a HOST-side akm process reads this same
 * file. The host's own ~/.config/akm/config.json is host-view: a local
 * LM Studio/Ollama engine or embedding endpoint is spelled
 * `http://localhost:1234/...`, and inside the assistant container that
 * loopback is the container itself. Importing it verbatim produced a config
 * that LOADED fine — so the import route's load-validation kept it — and
 * then failed every LLM call at use time with a connection error nothing
 * attributed to the import. core.compose.yml ships
 * `host.docker.internal:host-gateway` on the assistant unconditionally, so
 * the rewrite is container-reachable on Linux, macOS, and Windows alike.
 *
 * Deep walk over every string leaf, mirroring akm-user-env.ts's
 * rewriteHostDockerInternalDeep (the exact reverse direction) for the same
 * reason it gives: any endpoint-shaped field — present or added later, in
 * any engine — gets the fix without this code tracking akm's config schema.
 * Safe because only strings that BEGIN with a loopback http(s) origin are
 * touched; engine names, model ids, and genuinely remote URLs never match.
 */
const LOOPBACK_HOST_RE = /^(https?:\/\/)(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?=[:/]|$)/i;

function toContainerReachableDeep<T>(value: T): T {
  if (typeof value === "string")
    return value.replace(LOOPBACK_HOST_RE, "$1host.docker.internal") as unknown as T;
  if (Array.isArray(value)) return value.map((v) => toContainerReachableDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toContainerReachableDeep(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Copy the host's akm engine/embedding configuration into the assistant's.
 *
 * Loopback endpoints are rewritten to `host.docker.internal` on the way in —
 * host values only, never anything the operator already set here (see
 * {@link toContainerReachableDeep}).
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
  // Container-view translation BEFORE the merge, host values only — see
  // toContainerReachableDeep. The read stays strictly read-only: the walk
  // builds a rewritten copy and never touches the host's file.
  const hostView = toContainerReachableDeep(host);

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
  if (isObj(hostView.engines)) {
    // host first, existing last → existing wins; only host-only engine names are added.
    const merged: Record<string, unknown> = { ...(hostView.engines as Record<string, unknown>), ...opEngines };
    if (Object.keys(merged).length > Object.keys(opEngines).length) {
      engines = merged;
      imported.push("engines");
    }
  }

  // defaults.engine / defaults.llmEngine / defaults.improveStrategy — only
  // adopt a host selection when OpenPalm has none.
  const hostDefaults = isObj(hostView.defaults) ? (hostView.defaults as Record<string, unknown>) : {};
  const opDefaults = isObj(op.defaults) ? { ...(op.defaults as Record<string, unknown>) } : {};
  for (const key of ["engine", "llmEngine", "improveStrategy"] as const) {
    if (typeof hostDefaults[key] === "string" && typeof opDefaults[key] !== "string") {
      opDefaults[key] = hostDefaults[key];
      imported.push(`defaults.${key}`);
    }
  }

  // improve.strategies — additive by strategy name.
  const hostImprove = isObj(hostView.improve) ? (hostView.improve as Record<string, unknown>) : {};
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
  if (isObj(hostView.embedding)) {
    const existing = isObj(op.embedding) ? (op.embedding as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...(hostView.embedding as Record<string, unknown>), ...existing };
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
