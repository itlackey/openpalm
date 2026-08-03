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
 * Each successful version step is stamped immediately so a failure in a later
 * step cannot replay an earlier data migration.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createLogger } from '../logger.js';
import { migrateProfileOnlyAddonEnablement } from './addons.js';
import {
  migrateAccessIntent,
  migrateConsolidatedDefaultPorts,
  migrateLegacyBindAddresses,
  migrateLegacyDefaultPorts,
} from './config-persistence.js';
import { mergeEnvContent, parseEnvContent, removeEnvKey } from './env.js';
import { writeFileAtomic } from './fs-atomic.js';
import {
  HOME_SCHEMA_VERSION,
  hasAnyStackEnvFile,
  legacyKnowledgeStackEnvFile,
  legacyStateEnvFile,
  readHomeSchemaVersion,
  stackEnvFile,
  writeHomeSchemaVersion,
} from './home.js';
import { migrateDelegatedSecretsToPrivateDir } from './secrets-migration.js';
import { replaceTaskFileForHomeMigration } from './task-files.js';
import { SERVICE_VERSION_KEYS } from './versions.js';

const logger = createLogger('home-schema');
const DAILY_BRIEFING_TASK = 'assistant-daily-briefing.yml';
const RELEASED_DAILY_BRIEFING = `${[
  "schedule: '0 8 * * *'",
  'enabled: false',
  'description: Ask the assistant for a daily system health summary',
  'tags:',
  '  - openpalm',
  '  - assistant',
  'timeoutMs: 120000',
  'prompt: >-',
  '  Good morning. Give me a brief summary of system health, any recent',
  '  errors in the audit log, and open tasks.',
].join('\n')}\n`;
const VERSIONED_DAILY_BRIEFING = `version: 2\n${RELEASED_DAILY_BRIEFING}`;
const HISTORICAL_DAILY_BRIEFINGS = new Set([
  RELEASED_DAILY_BRIEFING,
  VERSIONED_DAILY_BRIEFING,
  RELEASED_DAILY_BRIEFING.replaceAll('\n', '\r\n'),
  VERSIONED_DAILY_BRIEFING.replaceAll('\n', '\r\n'),
]);
const CURRENT_DAILY_BRIEFING = `${[
  'version: 2',
  "schedule: '0 8 * * *'",
  'enabled: false',
  'description: Ask the assistant for a daily system health summary',
  'tags:',
  '  - openpalm',
  '  - assistant',
  'timeoutMs: 120000',
  'command:',
  '  - opencode',
  '  - run',
  '  - >-',
  '    Good morning. Give me a brief summary of system health, any recent',
  '    errors in the audit log, and open tasks.',
].join('\n')}\n`;

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

  if (!merged.endsWith('\n')) merged += '\n';

  if (existsSync(target)) {
    const current = readFileSync(target, 'utf-8');
    if (current === merged) return false;

    // Older releases could create a fallback target before migration. Legacy
    // values stay authoritative; retain only target-only keys.
    const currentValues = parseEnvContent(current);
    const defined = parseEnvContent(merged);
    const targetOnly: Record<string, string> = {};
    for (const [key, value] of Object.entries(currentValues)) {
      if (!(key in defined)) targetOnly[key] = value;
    }
    merged = mergeEnvContent(merged, targetOnly);
    if (!merged.endsWith('\n')) merged += '\n';
    if (current === merged) return false;
  }
  writeFileAtomic(target, merged, 0o600);
  logger.warn(
    'Consolidated the stack env files and retained the legacy inputs as recovery copies',
    {
      merged: sources,
      target,
    },
  );
  return true;
}

function migrateDailyBriefingTask(homeDir: string): boolean {
  return replaceTaskFileForHomeMigration(
    homeDir,
    DAILY_BRIEFING_TASK,
    HISTORICAL_DAILY_BRIEFINGS,
    CURRENT_DAILY_BRIEFING,
  );
}

function migrateDelegatedSecrets(homeDir: string): boolean {
  const result = migrateDelegatedSecretsToPrivateDir(homeDir);
  if (result.skippedMismatch.length > 0) {
    throw new Error(
      `Delegated secret migration is ambiguous; both copies were preserved and the home schema was not stamped: ${result.skippedMismatch.join(', ')}`,
    );
  }
  return result.migrated.length > 0;
}

const MIGRATION_STEPS: { version: number; run: ((homeDir: string) => boolean)[] }[] = [
  { version: 1, run: [migrateLegacyDefaultPorts, migrateLegacyBindAddresses] },
  { version: 2, run: [migrateToSingleStackEnv] },
  {
    version: 3,
    run: [(homeDir) => migrateProfileOnlyAddonEnablement(homeDir).changed, migrateDelegatedSecrets],
  },
  { version: 4, run: [migrateDelegatedSecrets] },
  { version: 5, run: [migrateAccessIntent, migrateConsolidatedDefaultPorts] },
  { version: 6, run: [migrateDailyBriefingTask] },
];

/**
 * Run whatever migrations this home still needs, then record that it is current.
 *
 * Returns whether anything actually changed on disk. An up-to-date home reads
 * one small file and returns — it never touches stack.env.
 */
export function runHomeMigrations(homeDir: string): boolean {
  const recorded = readHomeSchemaVersion(homeDir);
  if (recorded > HOME_SCHEMA_VERSION) {
    throw new Error(
      `OpenPalm home schema ${recorded} is newer than this release supports (${HOME_SCHEMA_VERSION})`,
    );
  }
  if (recorded === HOME_SCHEMA_VERSION) return false;

  // Nothing recorded and no stack env in any location this layout has used:
  // that is an absent install, not an unmigrated one. Stamping it here would
  // materialize state/ under a home the operator never created — `ensureHomeDirs`
  // stamps it if and when it is genuinely created.
  if (!hasAnyStackEnvFile(homeDir)) return false;
  let changed = false;
  for (const step of MIGRATION_STEPS) {
    if (step.version <= recorded) continue;
    for (const migration of step.run) {
      if (migration(homeDir)) changed = true;
    }
    writeHomeSchemaVersion(homeDir, step.version);
  }
  return changed;
}
