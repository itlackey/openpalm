/**
 * CLI runtime state bootstrap.
 *
 * Delegates to @openpalm/lib for all control-plane logic. The CLI
 * uses FilesystemAssetProvider (reads from stack/) and
 * validates configuration in place.
 */
import {
  createState,
  resolveRuntimeFiles,
  FilesystemAssetProvider,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';
import { defaultHomeDir } from './paths.ts';

/**
 * Ensure configuration state is valid and ready for Docker Compose operations.
 *
 * Uses FilesystemAssetProvider to read core assets and resolves artifacts.
 * Does NOT persist to disk — persistence happens inside runComposeWithPreflight()
 * after compose preflight validation, ensuring no mutation before validation.
 *
 * Returns a ControlPlaneState usable with fullComposeArgs().
 */
export async function ensureValidState(): Promise<ControlPlaneState> {
  const homeDir = defaultHomeDir();
  const assets = new FilesystemAssetProvider(homeDir);
  const state = createState();
  state.artifacts = resolveRuntimeFiles(state, assets);
  return state;
}
