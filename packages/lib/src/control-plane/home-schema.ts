/**
 * The one-shot legacy migrations, and the gate that lets them stop running.
 *
 * Every "migrate legacy X" function used to run on every deploy path, forever,
 * because nothing recorded whether it had already run. A home created today
 * still paid for all of them, permanently, and one of them
 * (`migrateLegacyDefaultPorts`) rewrites port values — which is how
 * `core.compose.yml`'s interpolation fallbacks were able to sit inverted for so
 * long: the migration silently corrected the inconsistency on every supported
 * path, so only a manual `docker compose` invocation ever saw the truth.
 *
 * The version record itself lives in `home.ts` (pure layout, no dependencies).
 * It is a bare integer in `state/schema-version` rather than a key in
 * `state/stack.env`, because that file is a Compose `--env-file` and this is
 * not a value any container should see.
 *
 * Adding a migration: bump `HOME_SCHEMA_VERSION` in `home.ts` and add an entry
 * below with `since` set to the version it upgrades FROM. Deleting one: drop
 * the entry once the supported upgrade floor has passed it — the version does
 * not need to move when a migration is removed.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOME_SCHEMA_VERSION,
  hasAnyStackEnvFile,
  legacyKnowledgeStackEnvFile,
  legacyStateEnvFile,
  readHomeSchemaVersion,
  stackEnvFile,
  writeHomeSchemaVersion,
} from './home.js';
import { writeFileAtomic } from './fs-atomic.js';
import { mergeEnvContent, parseEnvContent, removeEnvKey } from './env.js';
import { createLogger } from '../logger.js';
import {
  migrateAccessIntent,
  migrateConsolidatedDefaultPorts,
  migrateLegacyBindAddresses,
  migrateLegacyDefaultPorts,
  migrateRetiredOpencodeAuthKey,
} from './config-persistence.js';
import { migrateChatAddonRemoval, migrateProfileOnlyAddonEnablement } from './addons.js';
import { SERVICE_VERSION_KEYS } from './versions.js';
import { migrateDelegatedSecretsToPrivateDir } from './secrets-migration.js';
import { migrateLegacyPaperclipEnv } from './paperclip.js';

const logger = createLogger('home-schema');

/**
 * Collapse the two stack env files into one at `state/stack.env`.
 *
 * The split was a transition artifact: `knowledge/env/stack.env` held operator
 * config and `state/stack.state.env` held app-written records, both were passed
 * to Compose as `--env-file` with state last so it won, and eight call sites
 * hand-rolled the same "parse both, spread state over legacy" merge to read a
 * value the way the running stack would see it. Every one of those was a chance
 * to read the wrong file — `resolveActiveProfiles` did exactly that, so an
 * enabled addon never activated its profile.
 *
 * Precedence here is identical to what Compose applied, so the effective
 * configuration is unchanged by the move: legacy first, state over it.
 *
 * One exception, and it matters: a service version key in the KNOWLEDGE file was
 * never a pin. On older installs those values recorded the release that had last
 * been applied, which is why `readVersions` deliberately read only the state
 * tree — promoting them would freeze the install at its current images and stop
 * updates. They are dropped here. Real pins live in the state file and survive.
 */
function migrateToSingleStackEnv(homeDir: string): boolean {
  const target = stackEnvFile(homeDir);
  const knowledge = legacyKnowledgeStackEnvFile(homeDir);
  const state = legacyStateEnvFile(homeDir);
  const sources = [knowledge, state].filter(existsSync);
  if (sources.length === 0) return false;

  // Start from the knowledge file when present: it carries the operator's own
  // comments and section headers, which a key-only merge would throw away.
  let base = existsSync(knowledge) ? readFileSync(knowledge, 'utf-8') : '';
  for (const key of SERVICE_VERSION_KEYS) base = removeEnvKey(base, key);
  const overrides = existsSync(state) ? parseEnvContent(readFileSync(state, 'utf-8')) : {};

  // Strip every occurrence of an overridden key first: env parsing is
  // last-occurrence-wins, but mergeEnvContent rewrites only the first, so a
  // stale duplicate later in the operator file would silently beat the state
  // value the running stack was actually using.
  for (const key of Object.keys(overrides)) base = removeEnvKey(base, key);
  let merged = mergeEnvContent(base, overrides);

  // A target that exists while the legacy files are still here was written
  // BEFORE this migration ran — `ensureSystemSecrets` bootstraps one with
  // `OP_SETUP_COMPLETE=false` whenever the file is absent. Letting it override
  // would tell a fully-installed operator their setup never completed and send
  // them back to the wizard. It contributes only keys the real sources do not
  // define, so nothing is lost and nothing is clobbered.
  if (existsSync(target)) {
    const defined = parseEnvContent(merged);
    const targetOnly: Record<string, string> = {};
    for (const [key, value] of Object.entries(parseEnvContent(readFileSync(target, 'utf-8')))) {
      if (!(key in defined)) targetOnly[key] = value;
    }
    if (Object.keys(targetOnly).length > 0) merged = mergeEnvContent(merged, targetOnly);
  }
  if (!merged.endsWith('\n')) merged += '\n';

  writeFileAtomic(target, merged, 0o600);
  for (const source of sources) rmSync(source, { force: true });

  logger.warn('Consolidated the stack env files into state/stack.env', {
    merged: sources,
    target,
  });
  return true;
}

/**
 * Migrations that bring a home up FROM the version in `since`.
 *
 * Array order is the run order and is independent of `since`. The first two
 * rewrite the pre-consolidation knowledge file, so they must precede the
 * consolidation; `migrateProfileOnlyAddonEnablement` reads the *effective*
 * env and writes the app-owned record, so it must follow it.
 */
/**
 * Delete skeleton files a release moved or retired.
 *
 * Seeding outside `system/` is add-only: `copyTree(..., skipExisting)` never
 * overwrites and `overwriteSystemTree` prunes only inside `system/`. So a file
 * a release DELETED from the skeleton stays on every upgraded home forever,
 * and upgraded installs quietly diverge from fresh ones.
 *
 * Two sets, both confirmed present on a real upgraded home:
 *
 *  - `config/{assistant,guardian}/opencode.jsonc` — moved into `system/` by
 *    3087384a. These sit in directories mounted as OpenCode's USER config, so
 *    the stale copies are live-read: the assistant one still lists
 *    `akm-opencode@latest` (the unpinned spec the pinned managed config exists
 *    to eliminate) and `./instructions/*.md` paths that no longer exist there.
 *  - `knowledge/tasks/{health-check,update-containers,validate-config}.yml` —
 *    deleted by d9bc7ee4. akm never runs them, but OpenPalm's own task reader
 *    does not check `version`, so the Automations tab lists them as real
 *    automations — one of them as an enabled weekly `openpalm update`.
 *
 * Removal only. It never touches a file the current skeleton still ships, so
 * an operator's own edits to live files are untouched.
 */
function migrateRetiredSkeletonFiles(homeDir: string): boolean {
  const retired = [
    "config/assistant/opencode.jsonc",
    "config/guardian/opencode.jsonc",
    "knowledge/tasks/health-check.yml",
    "knowledge/tasks/update-containers.yml",
    "knowledge/tasks/validate-config.yml",
  ];
  let removed = false;
  for (const rel of retired) {
    const path = join(homeDir, rel);
    if (!existsSync(path)) continue;
    try {
      rmSync(path);
      removed = true;
    } catch {
      // Best-effort: a home we cannot clean is not a home we should refuse to
      // start. The stale file is inert config, not a blocker.
    }
  }
  if (removed) logger.warn("Removed retired skeleton files from OP_HOME", { retired });
  return removed;
}

const MIGRATIONS: { since: number; run: (homeDir: string) => boolean }[] = [
  { since: 0, run: migrateLegacyDefaultPorts },
  { since: 0, run: migrateLegacyBindAddresses },
  { since: 1, run: migrateToSingleStackEnv },
  { since: 0, run: (homeDir) => migrateProfileOnlyAddonEnablement(homeDir).changed },
  // G1: relocate delegated secrets (guardian/portal-only) out of the
  // assistant-reachable knowledge/secrets into private/secrets. Idempotent and
  // safe on every state a pre-existing home could be in (see
  // secrets-migration.ts/secrets-migration.test.ts); `since: 2` runs it for
  // every home below the new HOME_SCHEMA_VERSION (3), including ones that
  // never recorded a version at all (recorded 0 here still satisfies `2 >= 0`
  // since the loop condition is `migration.since >= recorded`).
  { since: 2, run: (homeDir) => migrateDelegatedSecretsToPrivateDir(homeDir).migrated.length > 0 },
  // Same migration again at `since: 3`, because the SET it iterates grew:
  // `op_session_signing_key` was added to DELEGATED_SECRET_NAMES, and a home
  // already stamped 3 would otherwise never re-run it and would keep the
  // cookie-signing key readable from the assistant's /stash. The function
  // re-checks real filesystem state, so this is a no-op for a home that has
  // no such file.
  { since: 3, run: (homeDir) => migrateDelegatedSecretsToPrivateDir(homeDir).migrated.length > 0 },
  // Record network-access INTENT explicitly in the consolidated state/stack.env
  // and strip the retired cascade keys from it. Must run AFTER
  // migrateToSingleStackEnv (since: 1) so it reads the merged file, and it is
  // the last place the legacy-aware bind inference is used for a migrated home.
  { since: 4, run: migrateAccessIntent },
  // The retired 3800/3810 pair, corrected on the CONSOLIDATED file. Runs after
  // migrateToSingleStackEnv for the same reason as migrateAccessIntent, and it
  // is what lets the UI delete its per-boot process-local re-derivation.
  { since: 4, run: migrateConsolidatedDefaultPorts },
  // Paperclip originally seeded an upstream key unused by the pinned image.
  // Preserve its entropy while moving it to the agent-JWT key the image reads.
  { since: 5, run: migrateLegacyPaperclipEnv },
  // Files a release deleted from the skeleton but that add-only seeding leaves
  // behind on every upgraded home.
  { since: 6, run: migrateRetiredSkeletonFiles },
  // The `chat` addon is removed. Drop it from OP_ENABLED_ADDONS and, when it
  // was the only guardianRequired reason, record guardianNetwork=true so the
  // install keeps its guardian front door. Must run before any reconcile's
  // pruneRemovedAddonState strips the now-unknown id without substitution —
  // ordering guaranteed because applyHome runs migrations first.
  { since: 7, run: migrateChatAddonRemoval },
  // OpenCode Basic auth is always on; the OPENCODE_AUTH row is retired. The
  // row is already inert (nothing interpolates or reads it), so this is
  // hygiene — plus the version bump that makes checkHomeSchemaSupported
  // refuse older binaries, whose resolvers would stop attaching auth against
  // always-authenticated containers.
  { since: 8, run: migrateRetiredOpencodeAuthKey },
];

/**
 * Run whatever migrations this home still needs, then record that it is current.
 *
 * Returns whether anything actually changed on disk. An up-to-date home reads
 * one small file and returns — it never touches stack.env.
 */
/**
 * Refuse to let an OLDER release write to a home a NEWER one already migrated.
 *
 * The schema record only ever ratchets forward, and every read of it treats
 * "recorded >= mine" as "nothing to do" — which is right for the same release
 * and silently wrong for an older one. An older binary run against a newer
 * `OP_HOME` (a rolled-back install, a second binary left on PATH, a
 * `self-update` that half-failed) does three things, none of them recoverable
 * by the operator without knowing what happened:
 *
 *   1. skips every migration between the two versions, because the record
 *      already claims a higher number than it knows about;
 *   2. rewrites the managed image tags DOWN to its own platform version in
 *      {@link advanceManagedImageVersions}, and re-stamps the managed markers
 *      so the downgrade looks deliberate and is never advanced back; and
 *   3. recreates the whole stack on those older images, against a home laid
 *      out for the newer ones — including the assistant image, which bakes
 *      the matching `@openpalm/ui` build.
 *
 * So the CLI, the UI it bakes, the home schema, and the image tags all skew
 * apart at once from a single mismatched invocation. This is the one check
 * that makes that combination unrepresentable, and it belongs on the WRITE
 * paths only: reading a newer home is harmless, and `openpalm status` /
 * `logs` / `doctor` are exactly what an operator needs while diagnosing this.
 *
 * `OP_ALLOW_HOME_DOWNGRADE=1` is the escape hatch, mirroring `OP_ALLOW_ROOT`:
 * supported, not recommended, and it must be asked for.
 */
export function checkHomeSchemaSupported(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): { ok: true } | { ok: false; recorded: number; supported: number; message: string } {
  const recorded = readHomeSchemaVersion(homeDir);
  if (recorded <= HOME_SCHEMA_VERSION) return { ok: true };
  if (env.OP_ALLOW_HOME_DOWNGRADE === '1') {
    logger.warn('proceeding against a newer OP_HOME (OP_ALLOW_HOME_DOWNGRADE=1)', {
      recorded,
      supported: HOME_SCHEMA_VERSION,
    });
    return { ok: true };
  }
  return {
    ok: false,
    recorded,
    supported: HOME_SCHEMA_VERSION,
    message:
      `This OP_HOME (${homeDir}) was written by a newer OpenPalm: it records home schema ` +
      `${recorded}, and this binary understands ${HOME_SCHEMA_VERSION}. Continuing would skip ` +
      'the migrations in between and roll every managed image tag back to this binary\'s ' +
      'version, leaving the CLI, the served UI, the home layout, and the containers on ' +
      'different releases.\n' +
      'Install the newer openpalm binary and rerun this command. To proceed anyway ' +
      '(supported, not recommended), set OP_ALLOW_HOME_DOWNGRADE=1.',
  };
}

/** {@link checkHomeSchemaSupported}, as a guard for the lifecycle write paths. */
export function assertHomeSchemaSupported(homeDir: string): void {
  const result = checkHomeSchemaSupported(homeDir);
  if (!result.ok) throw new Error(result.message);
}

export function runHomeMigrations(homeDir: string): boolean {
  const recorded = readHomeSchemaVersion(homeDir);
  if (recorded >= HOME_SCHEMA_VERSION) return false;

  // Nothing recorded and no stack env in any location this layout has used:
  // that is an absent install, not an unmigrated one. Stamping it here would
  // materialize state/ under a home the operator never created — `ensureHomeDirs`
  // stamps it if and when it is genuinely created.
  if (!hasAnyStackEnvFile(homeDir)) return false;

  let changed = false;
  for (const migration of MIGRATIONS) {
    if (migration.since < recorded) continue;
    if (migration.run(homeDir)) changed = true;
  }

  writeHomeSchemaVersion(homeDir, HOME_SCHEMA_VERSION);
  return changed;
}
