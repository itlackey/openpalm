/**
 * CLI runtime state bootstrap.
 *
 * Delegates to @openpalm/lib for all control-plane logic.
 * Validates configuration in place.
 */
import {
  classifyLocalInstall,
  createLogger,
  createState,
  resolveRuntimeFiles,
  runHomeMigrations,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';

const logger = createLogger('cli:state');

/**
 * Migrate the home layout, but never let that failure become the error the user
 * sees on a read-only command.
 *
 * The migration writes, and a home can legitimately be unwritable by this
 * process — a moved drive or a restored backup leaves it owned by the previous
 * host's uid, which is exactly the case `openpalm start` detects and explains
 * ("Host swap detected for OP_HOME ... --adopt-host"). Letting an EACCES from
 * the stamp escape here would replace that actionable diagnostic with a raw
 * errno, and would break `status`/`logs` on a home they can still read fine.
 * Consumers that are about to WRITE (compose preflight, install, applyHome)
 * call runHomeMigrations directly and keep the strict behavior.
 */
function migrateBestEffort(homeDir: string): void {
  try {
    runHomeMigrations(homeDir);
  } catch (error) {
    logger.warn('could not migrate the OP_HOME layout; continuing with what is readable', {
      homeDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Ensure configuration state is valid and ready for Docker Compose operations.
 *
 * Pure read of assets: resolves core assets/artifacts from OP_HOME and does NOT
 * persist any of them. Secrets and other OP_HOME assets are written ONLY by
 * install/update/apply (applyHome) — no self-healing on a plain command.
 *
 * The ONE exception is the OP_HOME schema migration, which has to run before
 * any state is read rather than after: on a home still using the pre-
 * consolidation layout, `state/stack.env` does not exist yet, so a read-only
 * command would resolve Compose with no env at all — reporting enabled add-ons
 * as disabled and selecting no addon profiles. It is a one-shot, gated on the
 * recorded version, and a no-op on a home that has no install to migrate.
 *
 * Returns a ControlPlaneState usable with buildComposeCliArgs().
 */
export function ensureValidState(): ControlPlaneState {
  const state = createState();
  migrateBestEffort(state.homeDir);
  if (classifyLocalInstall(state.stackDir, state.homeDir) === 'not_installed') {
    throw new Error('OpenPalm is not installed in this OP_HOME yet. Run `openpalm install` first.');
  }
  state.artifacts = resolveRuntimeFiles();
  return state;
}

/**
 * Like {@link ensureValidState}, but tolerates a not-installed OP_HOME:
 * returns the bootstrap state (no runtime artifacts) instead of throwing, so
 * the UI server can still come up and its setup guard lands on /setup.
 * Used by `openpalm admin`, which must serve on a machine with no install.
 * Migrates for the same reason as {@link ensureValidState}.
 */
export function resolveServeState(): ControlPlaneState {
  const state = createState();
  migrateBestEffort(state.homeDir);
  if (classifyLocalInstall(state.stackDir, state.homeDir) === 'not_installed') {
    return state;
  }
  state.artifacts = resolveRuntimeFiles();
  return state;
}
