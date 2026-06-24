/**
 * CLI runtime state bootstrap.
 *
 * Delegates to @openpalm/lib for all control-plane logic.
 * Validates configuration in place.
 */
import {
  classifyLocalInstall,
  createState,
  resolveRuntimeFiles,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';

/**
 * Ensure configuration state is valid and ready for Docker Compose operations.
 *
 * Pure read: resolves core assets/artifacts from OP_HOME and does NOT persist
 * anything. Secrets and other OP_HOME assets are written ONLY by
 * install/update/apply (reconcileHome) — no self-healing on a plain command.
 *
 * Returns a ControlPlaneState usable with buildComposeCliArgs().
 */
export function ensureValidState(): ControlPlaneState {
  const state = createState();
  if (classifyLocalInstall(state.stackDir) === 'not_installed') {
    throw new Error('OpenPalm is not installed in this OP_HOME yet. Run `openpalm install` first.');
  }
  state.artifacts = resolveRuntimeFiles();
  return state;
}
