/**
 * CLI runtime state bootstrap.
 *
 * Delegates to @openpalm/lib for all control-plane logic.
 * Validates configuration in place.
 */
import {
  createState,
  resolveRuntimeFiles,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';
import { defaultHomeDir } from './paths.ts';

/**
 * Ensure configuration state is valid and ready for Docker Compose operations.
 *
 * Reads core assets from OP_HOME and resolves artifacts.
 * Does NOT persist to disk — persistence happens inside runComposeWithPreflight()
 * after compose preflight validation, ensuring no mutation before validation.
 *
 * Returns a ControlPlaneState usable with fullComposeArgs().
 */
export async function ensureValidState(): Promise<ControlPlaneState> {
  const state = createState();
  state.artifacts = resolveRuntimeFiles(state);
  return state;
}
