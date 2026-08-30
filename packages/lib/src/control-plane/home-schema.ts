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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
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
  migrateRetiredOpencodeAuth,
  migrateConsolidatedDefaultPorts,
  migrateLegacyBindAddresses,
  migrateLegacyDefaultPorts,
} from './config-persistence.js';
import { migrateChatAddonRemoval, migrateProfileOnlyAddonEnablement } from './addons.js';
import { SERVICE_VERSION_KEYS } from './versions.js';
import { migrateDelegatedSecretsToStateDir } from './secrets-migration.js';
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

/** The task files d9bc7ee4 deleted from the skeleton. Swept twice — see below. */
const RETIRED_TASK_FILES = [
  "knowledge/tasks/health-check.yml",
  "knowledge/tasks/update-containers.yml",
  "knowledge/tasks/validate-config.yml",
] as const;

/**
 * Delete the paths that are present, and report the ones that actually went.
 *
 * Log what was ACTUALLY deleted, not the candidate list. This is the one
 * removal in the chain with no modification check — unlike the skills sweep it
 * never compares a file against what the release shipped — so this line is the
 * only record an operator gets of work that is now gone. Logging the static
 * array named all five every time, including the four it skipped, which told
 * someone who had customised `config/assistant/opencode.jsonc` nothing about
 * whether theirs was among them.
 */
function removeRetiredFiles(homeDir: string, retired: readonly string[]): boolean {
  const removed: string[] = [];
  for (const rel of retired) {
    const path = join(homeDir, rel);
    if (!existsSync(path)) continue;
    try {
      rmSync(path);
      removed.push(rel);
    } catch {
      // Best-effort: a home we cannot clean is not a home we should refuse to
      // start. The stale file is inert config, not a blocker.
    }
  }
  if (removed.length > 0) {
    logger.warn("Removed retired skeleton files from OP_HOME", { removed });
  }
  return removed.length > 0;
}

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
  return removeRetiredFiles(homeDir, [
    "config/assistant/opencode.jsonc",
    "config/guardian/opencode.jsonc",
    ...RETIRED_TASK_FILES,
  ]);
}

/**
 * The retired TASK files again, for the homes the sweep above never reached.
 *
 * `since: 6` was right on the day it was written and wrong a release later. The
 * loop runs an entry only when `migration.since >= recorded`, so that sweep
 * covers homes at 6 and below and nothing else. Every home upgraded during
 * 0.13.0 development is stamped 10, has therefore never run it, and still
 * carries all five files — confirmed on a real install.
 *
 * Left behind, these three are not merely untidy. They carry no `version:` key
 * at all, and akm 0.9.4 validates the ENTIRE desired task source set before it
 * mutates the scheduler: one file it cannot version rejects the set, so no cron
 * registration happens for ANY task, including the operator's own. `akm migrate
 * apply` does not rescue this — it is all-or-nothing too, and refuses to convert
 * anything while a blocker remains. So nothing self-heals; the files have to go.
 *
 * Only the task files are re-swept. The two `opencode.jsonc` files are a weaker
 * case and this entry deliberately does not make it: they break nothing, they
 * are merely stale, and they sit in the tree the operator owns and edits —
 * OpenCode's USER config directory, where `.jsonc` is a first-class spelling
 * beside the `opencode.json` the skeleton now ships. A blind second delete
 * there also lands on homes where the `since: 6` sweep already removed the
 * shipped copy, so a file at that path now is one someone put back. Homes at 6
 * and below still get the pair from that sweep, which is unchanged.
 */
function migrateRetiredTaskFiles(homeDir: string): boolean {
  return removeRetiredFiles(homeDir, RETIRED_TASK_FILES);
}

const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

/**
 * Move one file, copy → verify → delete, never the other way round.
 *
 * Returns whether the source was consumed. A destination that already exists
 * with DIFFERENT content leaves BOTH files where they are and returns false:
 * this runs over credentials, and picking a winner between two versions of a
 * signing key is not a decision a migration gets to make silently. Identical
 * content means a prior interrupted run already copied it, so only the source
 * is removed.
 */
function relocateFile(from: string, to: string): boolean {
  const content = readFileSync(from);
  if (existsSync(to)) {
    if (!readFileSync(to).equals(content)) {
      logger.warn('file present in both the old and new location with DIFFERENT content — leaving both in place for manual review', {
        from,
        to,
      });
      return false;
    }
    rmSync(from, { force: true });
    return true;
  }
  writeFileSync(to, content, { mode: SECRET_FILE_MODE });
  chmodSync(to, SECRET_FILE_MODE);
  if (!readFileSync(to).equals(content)) {
    logger.warn('copy failed verification; leaving the original in place', { from, to });
    return false;
  }
  rmSync(from, { force: true });
  return true;
}

/** rmdir if empty; a directory holding anything unexpected is left alone. */
function removeIfEmpty(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    rmdirSync(dir);
  } catch {
    // Non-empty (or not a directory): the operator put something here that
    // this migration does not know about, so it stays.
  }
}

/**
 * The OP_HOME layout change: `private/` folds into `state/`, and the skeleton
 * tree this release stopped shipping is cleaned up.
 *
 * Two parts, in this order:
 *
 *  1. `private/secrets/` → `state/secrets/` and `private/env/` →
 *     `state/env/`. `private/` was an eighth top-level tree whose entire job
 *     was "app-owned, not agent-reachable" — which is what `state/` already
 *     meant, so it was a second name for one answer. Every `secrets:` `file:`
 *     source in the three managed compose files moves with it, which is why
 *     this must complete before any compose command runs. Same copy → verify →
 *     delete discipline as the G1 relocation, and the same refusal to resolve
 *     a content conflict on its own.
 *  2. `knowledge/paperclip/{env,secrets}` — the always-empty overlay dirs the
 *     retired `/stash/env` + `/stash/secrets` overmounts pointed at.
 *
 * The third half of the move — dropping stash copies of skills that now ship
 * in `system/skills/` — is deliberately NOT here: it needs the shipped tree to
 * compare against, which only exists once the seed has run. It lives in
 * `applyHomeSeed` (ui-assets.ts), where that is guaranteed, and is idempotent
 * by construction so it needs no version gate.
 *
 * Ordering note: this entry sits FIRST in the list below so the credential
 * consolidation happens before the two knowledge/secrets sweeps at `since: 2`
 * and `since: 3`. On a home old enough to run all three, the `private/` copy is
 * the newer one, and moving it into place first means those sweeps compare
 * against it instead of creating a second candidate for the same name.
 */
function migrateOpHomeLayout(homeDir: string): boolean {
  let changed = false;

  const privateDir = join(homeDir, 'private');
  for (const leaf of ['secrets', 'env']) {
    const from = join(privateDir, leaf);
    if (!existsSync(from)) continue;
    const to = join(homeDir, 'state', leaf);
    mkdirSync(to, { recursive: true, mode: SECRETS_DIR_MODE });
    chmodSync(to, SECRETS_DIR_MODE);
    const moved: string[] = [];
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (relocateFile(join(from, entry.name), join(to, entry.name))) moved.push(entry.name);
    }
    if (moved.length > 0) {
      changed = true;
      logger.warn(`Moved OP_HOME private/${leaf} into state/${leaf}`, { moved, to });
    }
    removeIfEmpty(from);
  }
  removeIfEmpty(privateDir);

  for (const leaf of ['env', 'secrets']) removeIfEmpty(join(homeDir, 'knowledge', 'paperclip', leaf));
  removeIfEmpty(join(homeDir, 'knowledge', 'paperclip'));

  return changed;
}

/**
 * Migrations that bring a home up FROM the version in `since`.
 *
 * Array order is the run order and is independent of `since`. The first two
 * rewrite the pre-consolidation knowledge file, so they must precede the
 * consolidation; `migrateProfileOnlyAddonEnablement` reads the *effective*
 * env and writes the app-owned record, so it must follow it.
 */
const MIGRATIONS: { since: number; run: (homeDir: string) => boolean }[] = [
  // Layout: private/ → state/, plus the skeleton tree this release retired.
  // FIRST on purpose — see the docblock for why the credential move has to
  // precede the two knowledge/secrets sweeps below.
  { since: 9, run: migrateOpHomeLayout },
  { since: 0, run: migrateLegacyDefaultPorts },
  { since: 0, run: migrateLegacyBindAddresses },
  { since: 1, run: migrateToSingleStackEnv },
  { since: 0, run: (homeDir) => migrateProfileOnlyAddonEnablement(homeDir).changed },
  // G1: relocate delegated secrets (guardian/portal-only) out of the
  // assistant-reachable knowledge/secrets into state/secrets. Idempotent and
  // safe on every state a pre-existing home could be in (see
  // secrets-migration.ts/secrets-migration.test.ts); `since: 2` runs it for
  // every home below the new HOME_SCHEMA_VERSION (3), including ones that
  // never recorded a version at all (recorded 0 here still satisfies `2 >= 0`
  // since the loop condition is `migration.since >= recorded`).
  { since: 2, run: (homeDir) => migrateDelegatedSecretsToStateDir(homeDir).migrated.length > 0 },
  // Same migration again at `since: 3`, because the SET it iterates grew:
  // `op_session_signing_key` was added to DELEGATED_SECRET_NAMES (which now
  // lives in secrets-migration.ts, since routing no longer consults it), and a home
  // already stamped 3 would otherwise never re-run it and would keep the
  // cookie-signing key readable from the assistant's /stash. The function
  // re-checks real filesystem state, so this is a no-op for a home that has
  // no such file.
  { since: 3, run: (homeDir) => migrateDelegatedSecretsToStateDir(homeDir).migrated.length > 0 },
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
  // OpenCode's auth no longer tracks publication, so OPENCODE_AUTH is a
  // stale row on every upgraded home. Note what the bump does NOT buy: there
  // is no downgrade guard. `runHomeMigrations` only returns early on
  // `recorded >= HOME_SCHEMA_VERSION`, and nothing else consumes
  // `readHomeSchemaVersion` to enforce anything — so an older binary pointed
  // at a migrated home is not refused. It silently skips its own migrations,
  // then seeds managed compose files naming the pre-migration paths, and its
  // credential resolver still honours OPENCODE_AUTH, so it attaches nothing
  // against always-authenticated containers and 401s. The recovery is a
  // restore, not a version check.
  { since: 8, run: migrateRetiredOpencodeAuth },
  // The three versionless task files, for homes already stamped 7 or higher —
  // which the `since: 6` entry above cannot reach. Cron registration is dead on
  // every one of them until these are gone; see the docblock.
  { since: 10, run: migrateRetiredTaskFiles },
];

/**
 * Run whatever migrations this home still needs, then record that it is current.
 *
 * Returns whether anything actually changed on disk. An up-to-date home reads
 * one small file and returns — it never touches stack.env.
 */
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
