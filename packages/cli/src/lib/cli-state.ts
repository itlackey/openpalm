/**
 * CLI runtime state bootstrap.
 *
 * Delegates to @openpalm/lib for all control-plane logic.
 * Validates configuration in place.
 */
import {
  classifyLocalInstall,
  createState,
  initializeStateSecrets,
  resolveRuntimeFiles,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';

/**
 * Ensure configuration state is valid and ready for Docker Compose operations.
 *
 * Reads core assets from OP_HOME and resolves artifacts.
 * Does NOT persist to disk — persistence happens inside runComposeWithPreflight()
 * after compose preflight validation, ensuring no mutation before validation.
 *
 * Returns a ControlPlaneState usable with buildComposeCliArgs().
 */
export function ensureValidState(): ControlPlaneState {
  const state = createState();
  initializeStateSecrets(state);
  if (classifyLocalInstall(state.stackDir) === 'not_installed') {
    throw new Error('OpenPalm is not installed in this OP_HOME yet. Run `openpalm install` first.');
  }
  state.artifacts = resolveRuntimeFiles();
  return state;
}
