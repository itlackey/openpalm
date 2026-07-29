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
import { migrateLegacyBindAddresses, migrateLegacyDefaultPorts } from './config-persistence.js';
import { migrateProfileOnlyAddonEnablement } from './addons.js';
import { SERVICE_VERSION_KEYS } from './versions.js';
import { migrateDelegatedSecretsToPrivateDir } from './secrets-migration.js';

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
