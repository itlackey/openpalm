/**
 * Home directory layout for the OpenPalm control plane (v0.11.0+).
 *
 * Single ~/.openpalm/ root, split by ownership (constitution §1):
 *   config/    — USER: editable config + system config files (akm/)
 *   config/stack/ — USER: the custom.compose.yml overlay ONLY (seeded once, never overwritten)
 *   system/stack/ — MANAGED: fixed compose files (core/services/portals), overwritten on reconcile
 *   data/      — RUNTIME: persistent service data, logs, backups, rollback (never written by install/update)
 *   knowledge/ — USER/services: akm knowledge (user env, secrets, tasks)
 *   workspace/ — USER: shared assistant work area
 *   state/     — app-written records AND generated runtime config: stack.env (THE
 *                non-secret Compose --env-file), host identity, schema version,
 *                generated config a container reads (state/remote/), and the
 *                credentials never mounted into the assistant (state/secrets/,
 *                state/env/) — all app-owned, none release-shipped
 *   cache/     — SYSTEM: regenerable container caches
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

// ── Path Resolution ──────────────────────────────────────────────────

function resolveHome(): string {
  const home = homedir();
  if (home) return home;

  return tmpdir();
}

/**
 * THE OP_HOME root, canonicalized (§F7).
 *
 * realpath runs HERE, at the single place the root is resolved, so a symlinked
 * home normalizes once instead of per call site: every "is this path under
 * OP_HOME?" test (bind-mount pre-creation, purge, backup scope) then compares
 * canonical against canonical. A root that does not exist yet — the moment
 * before `ensureHomeDirs` — has nothing to canonicalize, so the lexical path
 * stands.
 */
export function resolveOpenPalmHome(): string {
  const raw = process.env.OP_HOME;
  const home = raw ? resolvePath(raw) : `${resolveHome()}/.openpalm`;
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

export function resolveConfigDir(): string {
  return `${resolveOpenPalmHome()}/config`;
}

export function resolveStashDir(): string {
  return `${resolveOpenPalmHome()}/knowledge`;
}

export function resolveWorkspaceDir(): string {
  return `${resolveOpenPalmHome()}/workspace`;
}

export function resolveDataDir(): string {
  return `${resolveOpenPalmHome()}/data`;
}

/**
 * Regenerable cache tree (§S1). Deliberately a sibling of `data/`, not a child:
 * everything here is safe to delete at any time, which is what lets
 * `doctor --clean-caches` purge it, backups skip it, and `--purge` remove it
 * without a second thought about durable state.
 */
export function resolveCacheDir(): string {
  return `${resolveOpenPalmHome()}/cache`;
}

export function resolveStackDir(): string {
  return stackDirFor(resolveOpenPalmHome());
}

/** Managed tree (constitution §1): release-shipped assets, overwritten wholesale. */
export function resolveSystemDir(): string {
  return `${resolveOpenPalmHome()}/system`;
}

/**
 * State tree: app-written records (pins, enabled add-ons, channel, setup), the
 * runtime config this application generates for containers to read — the
 * remote addon's serve config (see remoteServeConfigDir) is bind-mounted from
 * here — and the credentials that are never mounted into the assistant
 * (`state/secrets/`, `state/env/`; §G1). All of it is app-owned; none of it is
 * release-shipped, and none of it is reachable from the assistant's `/stash`.
 */
export function resolveStateDir(): string {
  return `${resolveOpenPalmHome()}/state`;
}

// ── Well-known files — THE single source of truth ────────────────────────────
// Every well-known path is defined HERE, once, derived from an explicit `home`.
// Moving a file/dir is a one-line edit in this section — never a grep-and-replace
// across the codebase. (This section exists specifically to kill the blast-radius
// class of change, e.g. `${state.stashDir}/env/stack.env` duplicated 18×.)

/** The managed compose dir for a home root (homeDir-param form of resolveStackDir). */
export function stackDirFor(home: string): string {
  return `${home}/system/stack`;
}
/** A MANAGED fixed compose file in the system stack dir (overwritten on reconcile). */
export function composeFilePath(home: string, name: string): string {
  return `${stackDirFor(home)}/${name}`;
}
/**
 * The USER-owned custom compose overlay. It lives in the user tree
 * (config/stack/), NOT the managed system/stack/ — co-locating a never-overwrite
 * user file inside the wholesale-overwritten managed tree is forbidden by the
 * four-tree ownership model (constitution §1). Seeded once, never clobbered.
 */
export function customComposeFilePath(home: string): string {
  return `${home}/config/stack/custom.compose.yml`;
}
/**
 * THE non-secret stack env file — the single Compose `--env-file`.
 *
 * Lives in `state/` because the control plane writes it (constitution §1), and
 * deliberately NOT in `knowledge/`, which is bind-mounted into the assistant at
 * `/stash`: host ports, image tags and the setup flag are not the agent's
 * business. Operators may still edit it directly; it is app-owned, not
 * app-exclusive.
 */
export function stackEnvFile(home: string): string {
  return `${home}/state/stack.env`;
}

// ── Superseded env files — migration inputs only ─────────────────────────────
// Read by the schema-2 migration in home-schema.ts, which merges them into
// stackEnvFile() and deletes them. Nothing else may reference these.

/** Pre-split app-written record (pins/add-ons/channel/setup). */
export function legacyStateEnvFile(home: string): string {
  return `${home}/state/stack.state.env`;
}
export function hostIdentityFile(home: string): string {
  return `${home}/state/host-identity.json`;
}
/** OP_HOME layout schema version — gates the one-shot legacy migrations. */
export function homeSchemaVersionFile(home: string): string {
  return `${home}/state/schema-version`;
}

/**
 * Does this home carry a stack env file in ANY layout this project has used?
 *
 * The one predicate for "there is something here already": the migration gate
 * uses it to tell an unmigrated install from an absent one, and `openpalm
 * install` uses it so a pre-consolidation home is never mistaken for a fresh
 * machine (which would skip the --force backup confirmation). Keeping it here
 * means consumers never need the superseded path helpers.
 */
export function hasAnyStackEnvFile(home: string): boolean {
  return [stackEnvFile(home), legacyStateEnvFile(home), legacyKnowledgeStackEnvFile(home)].some(existsSync);
}

/**
 * Current OP_HOME layout schema version.
 *
 * The version record lives here rather than beside the migration list because
 * it is pure layout — putting it in `home-schema.ts` would make this module
 * depend on `config-persistence`/`addons`, which depend back on this one.
 */
export const HOME_SCHEMA_VERSION = 12;

/** The recorded schema version, or 0 when nothing is recorded (pre-record home). */
export function readHomeSchemaVersion(home: string): number {
  const path = homeSchemaVersionFile(home);
  if (!existsSync(path)) return 0;
  const parsed = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function writeHomeSchemaVersion(home: string, version: number): void {
  // Atomic: a torn plain write would leave a file that parses as version 0
  // and silently re-runs every one-shot migration on the next command.
  writeFileAtomic(homeSchemaVersionFile(home), `${version}\n`, 0o644);
}

/**
 * Stamp a brand-new home as already current, so it runs no legacy migrations.
 *
 * "Brand new" is the absence of every stack env file this layout has ever used.
 * This runs from {@link ensureHomeDirs}, which every install path calls BEFORE
 * seeding — the only moment that question is still answerable. A home that
 * somehow reaches migration time unstamped falls back to version 0 and runs the
 * migrations once, which is the safe direction.
 */
export function initHomeSchema(home: string): void {
  if (existsSync(homeSchemaVersionFile(home))) return;
  if (hasAnyStackEnvFile(home)) return;
  writeHomeSchemaVersion(home, HOME_SCHEMA_VERSION);
}
/** Pre-split operator env, from when stack config lived in the knowledge tree. */
export function legacyKnowledgeStackEnvFile(home: string): string {
  return `${home}/knowledge/env/stack.env`;
}
/** User env (AKM-loaded on demand — never a Compose --env-file). */
export function userEnvFile(home: string): string {
  return `${home}/knowledge/env/user.env`;
}
export function secretsDir(home: string): string {
  return `${home}/knowledge/secrets`;
}

/**
 * The `remote` addon's generated Tailscale Serve/Funnel config DIRECTORY,
 * bind-mounted into the `tunnel` container.
 *
 * Must be a directory mount, not a file mount: Tailscale's containerboot
 * registers an fsnotify watch on the DIRECTORY and hard-fails at startup if
 * that watch cannot be added, so the directory has to exist before the
 * container is created. A directory mount also makes atomic config writes
 * (temp file + rename, same pattern as writeFileAtomic elsewhere in this
 * codebase) visible to the container — bind-mounting the single generated
 * file instead would pin that file's inode, and a rename-based rewrite would
 * leave the container reading the stale copy forever.
 *
 * Lives under `state/` (app-written records) and NOT under `system/stack/`
 * with the compose files, even though it is stack configuration, because
 * `system/` is the MANAGED tree: overwriteSystemTree replaces it wholesale
 * from the release skeleton on every update (renaming the old tree aside and
 * moving the staged copy into place). The skeleton ships no `remote/`
 * directory, so a serve config kept there — and the directory itself — is
 * DESTROYED by the next update that changes any managed file, after which
 * containerboot log.Fatalf's on the missing watch target and the tunnel
 * refuses to start. `state/` is never touched by that overwrite, which is
 * exactly the distinction the tree layout in ensureHomeDirs draws: system/ is
 * release-shipped assets, state/ is what this application generates.
 */
export function remoteServeConfigDir(home: string): string {
  return `${home}/state/remote`;
}

/**
 * The `remote` addon's persistent tunnel state (Tailscale's node identity and
 * keys), a data volume for the `tunnel` container. Must pre-exist and must
 * survive: losing it makes the tailnet node re-register from scratch, which
 * Tailscale resolves a hostname collision on by appending "-1" — silently
 * changing the assistant's public URL out from under every bookmark, shared
 * link and shortcut that pointed at the old one.
 */
export function remoteTunnelStateDir(home: string): string {
  return `${home}/data/tunnel`;
}

export function authJsonFile(home: string): string {
  return `${secretsDir(home)}/auth.json`;
}

/**
 * The DEFAULT secrets location — never exposed through the Assistant stash.
 *
 * `knowledge/` (including `knowledge/secrets/`) is bind-mounted wholesale into
 * the assistant at `/stash` (core.compose.yml) and is
 * `external_directory "/stash/*":"allow"`-reachable by the agent's own bash
 * tool. `state/` is not mounted there at all, which is what makes it the safe
 * default: `secrets-files.ts` routes every name here unless it is explicitly
 * agent-readable, and every container grant but `guardian_auth_json` points
 * here. Host consumers read these files directly; container consumers receive
 * only named Compose secrets. 0700, like `secretsDir`.
 */
export function stateSecretsDir(home: string): string {
  return `${home}/state/secrets`;
}

/**
 * Generated env files handed to a container as an `env_file` — Paperclip's
 * upstream-required keys (see paperclip.ts) are the only ones today. Same
 * exposure answer as its sibling `state/secrets/`: app-written, 0700, and
 * outside the assistant's `/stash`.
 */
export function stateEnvDir(home: string): string {
  return `${home}/state/env`;
}

export function resolveLogsDir(): string {
  return `${resolveDataDir()}/logs`;
}

/**
 * Resolve the backup destination for a given OP_HOME root.
 *
 * Defaults to `${home}/data/backups` (the historical, same-filesystem
 * location). `OP_BACKUP_DIR`, when set, overrides it and may point anywhere
 * else — e.g. a separate volume/filesystem with more headroom than OP_HOME's.
 * Every backup producer (the safety snapshots in backup.ts) resolves through
 * here so the destination is configured in exactly one place (S5).
 */
export function resolveBackupsDirFor(home: string): string {
  const override = process.env.OP_BACKUP_DIR;
  if (override) return resolvePath(override);
  return `${home}/data/backups`;
}

export function resolveBackupsDir(): string {
  return resolveBackupsDirFor(resolveOpenPalmHome());
}

export function resolveRollbackDir(): string {
  return `${resolveDataDir()}/rollback`;
}

/**
 * The akm durable-data roots — one per akm-bearing service, each bind-mounted
 * into its container at /opt/akm/data (core.compose.yml, services.compose.yml).
 * Every SQLite store akm owns lives under one of these. Defined ONCE, consumed
 * by BOTH {@link ensureHomeDirs} (creation) and the WAL-residue sweep
 * (akm-db-journal.ts), so a new akm-bearing service cannot be added to the
 * tree without also being swept.
 */
export function akmDataRoots(home: string): string[] {
  return [`${home}/data/akm/data`, `${home}/data/paperclip-akm/data`];
}

// ── Directory Setup ──────────────────────────────────────────────────

/**
 * Create the full OP_HOME directory tree.
 *
 * `home` defaults to the resolved OP_HOME; the CLI install flow passes its
 * already-resolved home explicitly. This is the ONLY definition of the tree —
 * the CLI used to keep a second, drifting copy that had silently fallen behind
 * (no `system/`, no `state/`, no `config/guardian`, none of the per-service
 * dot-directories under `data/`).
 */
export function ensureHomeDirs(home: string = resolveOpenPalmHome()): void {
  for (const dir of [
    // config/ — user-editable config + system config files
    `${home}/config`,
    `${home}/config/assistant`,
    `${home}/config/guardian`,
    `${home}/config/akm`,           // akm XDG config directory
    `${home}/config/paperclip/opencode`, // Paperclip OpenCode global config
    `${home}/config/paperclip/akm`, // Paperclip's isolated AKM config
    `${home}/config/stack`,         // user-owned custom.compose.yml overlay (seeded once)

    // cache/ — regenerable, purgeable, and NEVER backed up. Pre-created here
    // (operator-owned) because Docker creates a MISSING bind-mount source
    // root-owned, which is precisely what broke the first S1 attempt
    // (commit 921412b1) under rootless.
    `${home}/cache`,
    `${home}/cache/assistant`,
    `${home}/cache/guardian`,
    `${home}/cache/guardian-opencode`, // regenerable moderator OpenCode config
    `${home}/cache/guardian-opencode/runtime`, // mutable copy of system/guardian
    `${home}/cache/paperclip-opencode`, // regenerable OpenCode plugin dependencies
    `${home}/cache/paperclip-opencode/runtime`, // mutable config + node_modules

    // data/ — persistent service data
    `${home}/data`,
    `${home}/data/assistant`,      // assistant HOME bind mount
    `${home}/data/assistant/.cache`,
    `${home}/data/assistant/.config/opencode`,
    `${home}/data/assistant/.local/bin`,
    `${home}/data/assistant/.local/share/opencode`,
    `${home}/data/assistant/.local/state/opencode`,
    `${home}/data/guardian`,       // guardian runtime data
    `${home}/data/guardian/.cache`,
    `${home}/data/guardian/.config/opencode`,
    `${home}/data/guardian/.local/share/opencode`,
    `${home}/data/guardian/.local/state/opencode`,
    `${home}/data/paperclip`,       // Paperclip HOME bind mount
    `${home}/data/paperclip/.config/opencode`, // nested read-only user-config mountpoint
    `${home}/data/tunnel`,         // remote addon: persistent tailnet node identity (see remoteTunnelStateDir)
    `${home}/data/akm/cache`,      // akm cache
    ...akmDataRoots(home),         // akm durable data (assistant + Paperclip; also WAL-swept, see akmDataRoots)
    `${home}/data/akm/data/state`, // akm task-scheduler state (AKM_STATE_DIR, akm >= 0.9.0)
    `${home}/data/akm/empty-host-stash`, // always-present /host-stash fallback when host AKM is absent
    `${home}/data/paperclip-akm/cache`, // Paperclip AKM cache
    `${home}/data/paperclip-akm/data/state`, // Paperclip AKM scheduler state
    `${home}/data/logs`,           // service logs and audit files
    `${home}/data/ui`,             // materialized UI build (CLI-embedded, or bundled/repo-resolved)
    `${home}/data/backups`,        // lifecycle backup snapshots
    `${home}/data/rollback`,       // deploy rollback snapshots
    // knowledge/ — akm knowledge (skills, env, secrets, agents); knowledge/tasks/ for scheduled automations
    `${home}/knowledge`,
    `${home}/knowledge/env`,
    `${home}/knowledge/secrets`,
    `${home}/knowledge/tasks`,

    // workspace/ — shared assistant work area
    `${home}/workspace`,

    // system/ — managed tree (release-shipped assets, overwritten); state/ —
    // app-written records, generated runtime config (state/remote/) and the
    // credentials the assistant must never reach (state/secrets/, state/env/)
    `${home}/system/stack`,         // fixed compose files (managed, overwritten on update)
    `${home}/system/assistant`,     // MANAGED assistant OpenCode config (OPENCODE_CONFIG_DIR)
    `${home}/system/guardian`,      // MANAGED guardian OpenCode config (mounted :ro)
    `${home}/system/paperclip`,     // MANAGED Paperclip OpenCode plugin bootstrap
    `${home}/system/skills`,        // MANAGED release-shipped akm skills (:ro system bundle)
    `${home}/state`,
    `${home}/state/remote`,         // remote addon: generated Tailscale serve config (see remoteServeConfigDir)
    `${home}/state/secrets`,        // the default secrets tree (never assistant-reachable; §G1)
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // Stamp a brand-new home as schema-current so it runs no legacy migrations.
  // Must happen here: every install path calls this BEFORE seeding, which is
  // the only moment "is this home new?" is still answerable.
  initHomeSchema(home);

  for (const file of [
    `${home}/data/assistant/.local/share/opencode/auth.json`,
    `${home}/data/guardian/.local/share/opencode/auth.json`,
  ]) {
    if (!existsSync(file)) writeFileSync(file, '');
  }
}
