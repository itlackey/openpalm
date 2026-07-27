/**
 * G1 migration: relocate delegated secrets out of `knowledge/secrets/`
 * (bind-mounted wholesale into the assistant at `/stash`, and
 * `external_directory "/stash/*":"allow"`-reachable by the agent's own bash
 * tool) into `private/secrets/` (never mounted into the assistant; granted to
 * the guardian/portal containers ONLY via Compose `secrets: file:` entries).
 * See docs/public-seams-review.md §G1.
 *
 * Non-destructive and idempotent by construction, independent of the
 * one-shot schema-version gate that also calls it (home-schema.ts): every
 * name is copied to the new location and the copy is READ BACK AND VERIFIED
 * before the original is ever removed. A verification failure — or the two
 * locations already disagreeing (e.g. an operator or a previous partial
 * migration left non-identical content in both places) — leaves BOTH files in
 * place rather than picking one to delete, and logs loudly so it can be
 * resolved by hand. Safe to call on every deploy: an already-migrated name
 * (present only in the new location) and an untouched name (present in
 * neither) are both no-ops.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateSecretsDir, secretsDir } from './home.js';
import { DELEGATED_SECRET_NAMES } from './secrets-files.js';
import { createLogger } from '../logger.js';

const logger = createLogger('secrets-migration');

const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

export type DelegatedSecretMigrationResult = {
  /** Copied to private/secrets this run (or a prior interrupted run) and the knowledge/secrets original removed. */
  migrated: string[];
  /** Already present only in private/secrets — nothing to do. */
  alreadyMigrated: string[];
  /** Present in BOTH locations with DIFFERENT content — left untouched, logged for manual review. */
  skippedMismatch: string[];
  /** Present in neither location (never provisioned on this install). */
  absent: string[];
};

/**
 * Run the migration for one OP_HOME. Call on every deploy/upgrade path (it is
 * wired into `home-schema.ts`'s one-shot migrations); also directly callable
 * (e.g. from a standalone `openpalm doctor`-style repair) since it re-checks
 * actual filesystem state rather than trusting the schema-version gate alone.
 */
export function migrateDelegatedSecretsToPrivateDir(homeDir: string): DelegatedSecretMigrationResult {
  const oldDir = secretsDir(homeDir);
  const newDir = privateSecretsDir(homeDir);
  mkdirSync(newDir, { recursive: true, mode: SECRETS_DIR_MODE });
  chmodSync(newDir, SECRETS_DIR_MODE);

  const result: DelegatedSecretMigrationResult = {
    migrated: [],
    alreadyMigrated: [],
    skippedMismatch: [],
    absent: [],
  };

  for (const name of DELEGATED_SECRET_NAMES) {
    const oldPath = join(oldDir, name);
    const newPath = join(newDir, name);
    const oldExists = existsSync(oldPath);
    const newExists = existsSync(newPath);

    if (!oldExists && !newExists) {
      result.absent.push(name);
      continue;
    }

    if (!oldExists && newExists) {
      result.alreadyMigrated.push(name);
      continue;
    }

    // oldExists is true from here on (newExists may or may not be).
    const oldContent = readFileSync(oldPath);

    if (newExists) {
      const newContent = readFileSync(newPath);
      if (!oldContent.equals(newContent)) {
        result.skippedMismatch.push(name);
        logger.warn(
          'delegated secret present in both knowledge/secrets and private/secrets with DIFFERENT content — leaving both in place for manual review',
          { name, oldPath, newPath },
        );
        continue;
      }
      // Identical content already copied by a prior interrupted run — finish
      // the cleanup (remove the now-redundant, assistant-reachable original).
      rmSync(oldPath, { force: true });
      result.migrated.push(name);
      logger.warn('removed already-migrated delegated secret leftover from knowledge/secrets (interrupted prior migration)', {
        name,
        path: oldPath,
      });
      continue;
    }

    // Fresh migration: copy, verify by reading the copy back, THEN remove the
    // source. Never remove the source before the copy is confirmed byte-identical.
    writeFileSync(newPath, oldContent, { mode: SECRET_FILE_MODE });
    chmodSync(newPath, SECRET_FILE_MODE);
    const verify = readFileSync(newPath);
    if (!verify.equals(oldContent)) {
      logger.warn('delegated secret copy failed verification; leaving the knowledge/secrets original in place', {
        name,
        oldPath,
        newPath,
      });
      continue;
    }
    rmSync(oldPath, { force: true });
    result.migrated.push(name);
    logger.warn('migrated delegated secret out of knowledge/secrets (assistant-reachable /stash) into private/secrets', {
      name,
      from: oldPath,
      to: newPath,
    });
  }

  return result;
}
