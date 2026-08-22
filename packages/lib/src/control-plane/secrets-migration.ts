/**
 * G1 migration: relocate delegated secrets out of `knowledge/secrets/`
 * (bind-mounted wholesale into the assistant at `/stash`, and
 * `external_directory "/stash/*":"allow"`-reachable by the agent's own bash
 * tool) into `state/secrets/` (never mounted into the assistant; granted to
 * container consumers through named Compose secrets; host consumers read the
 * state files directly).
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
import { secretsDir, stateSecretsDir } from './home.js';
import { portalSecretName } from './secrets-files.js';
import { PORTAL_SECRET_ADDON_IDS } from './addon-ids.js';
import { createLogger } from '../logger.js';

const logger = createLogger('secrets-migration');

const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

/**
 * The names this migration relocates: every delegated credential a pre-0.13
 * home could have left in `knowledge/secrets/`.
 *
 * It lives here, not in `secrets-files.ts`, because it is no longer a routing
 * decision — routing is default-deny now (`AGENT_READABLE_SECRET_NAMES`) and
 * this set's only job is naming the files an already-installed home still has
 * in the wrong tree. Keeping it next to the writer is what let A2 happen: a
 * secret nobody added leaked, and growing the set meant re-running a one-shot
 * migration behind a schema bump.
 *
 * The portal principal secrets (`portal_<id>_secret`) are derived from
 * `PORTAL_SECRET_ADDON_IDS` — the same single source of truth
 * `ensurePortalSecret` uses — so this list can never drift from the set of
 * portal secrets actually provisioned.
 */
export const DELEGATED_SECRET_NAMES: ReadonlySet<string> = new Set([
  'op_guardian_admin_token',
  'op_guardian_mcp_token',
  'op_api_key',
  'discord_bot_token',
  'slack_bot_token',
  'slack_app_token',
  'op_opencode_password',
  'op_ui_login_password',
  // The HMAC key mixed into every session cookie. It belongs here for the same
  // reason op_ui_login_password does, and was missed when that one moved: with
  // the key readable from /stash, anything running inside the assistant — or
  // anything that prompt-injects it — can forge a valid host-admin session
  // cookie, which is precisely the attack the key exists to prevent.
  'op_session_signing_key',
  // Tailnet join credential (TS_AUTHKEY) for the `remote` addon's tunnel
  // container. It is handed to `tunnel` only as a Compose secret, never read
  // from stack.env or the stash. Anything that can read it can use it to
  // enroll an arbitrary device onto the user's own tailnet — i.e. it grants
  // network access to every other device the user has signed in there, not
  // just this assistant — so, like the portal secrets, it must stay out of the
  // assistant-visible /stash tree.
  'ts_authkey',
  ...PORTAL_SECRET_ADDON_IDS.map(portalSecretName),
]);

export type DelegatedSecretMigrationResult = {
  /** Copied to state/secrets this run (or a prior interrupted run) and the knowledge/secrets original removed. */
  migrated: string[];
  /** Already present only in state/secrets — nothing to do. */
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
export function migrateDelegatedSecretsToStateDir(homeDir: string): DelegatedSecretMigrationResult {
  const oldDir = secretsDir(homeDir);
  const newDir = stateSecretsDir(homeDir);
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
          'delegated secret present in both knowledge/secrets and state/secrets with DIFFERENT content — leaving both in place for manual review',
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
    logger.warn('migrated delegated secret out of knowledge/secrets (assistant-reachable /stash) into state/secrets', {
      name,
      from: oldPath,
      to: newPath,
    });
  }

  return result;
}
