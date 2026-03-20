/**
 * CLI-side configuration pipeline for Docker Compose operations.
 *
 * Delegates to @openpalm/lib for all control-plane logic. The CLI
 * uses FilesystemAssetProvider (reads from config/components/) and
 * validates configuration in place (no staging tier).
 */
import { existsSync } from 'node:fs';
import {
  createState,
  resolveArtifacts,
  persistConfiguration,
  buildComposeFileList,
  buildManagedServices,
  buildEnvFiles,
  FilesystemAssetProvider,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';
import { defaultHomeDir } from './paths.ts';

/**
 * Ensure configuration is valid and ready for Docker Compose operations.
 *
 * Uses FilesystemAssetProvider to read core assets and writes
 * configuration directly to live paths (no staging tier).
 *
 * Returns a ControlPlaneState usable with fullComposeArgs().
 */
export async function ensureValidState(): Promise<ControlPlaneState> {
  const homeDir = defaultHomeDir();

  // Verify core assets exist (populated by `openpalm install`)
  const assets = new FilesystemAssetProvider(homeDir);

  const state = createState();
  state.artifacts = resolveArtifacts(state, assets);
  persistConfiguration(state, assets);

  return state;
}

/** @deprecated Use ensureValidState() */
export const ensureStagedState = ensureValidState;

/**
 * Build the full list of docker compose CLI arguments for a given state.
 *
 * Returns: ['--project-name', 'openpalm', '-f', '...', '--env-file', '...']
 */
export function fullComposeArgs(state: ControlPlaneState): string[] {
  const files = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);

  return [
    '--project-name',
    'openpalm',
    ...files.flatMap((f) => ['-f', f]),
    ...envFiles.filter((f) => existsSync(f)).flatMap((f) => ['--env-file', f]),
  ];
}

/**
 * Build the list of managed service names (used for targeted `up` commands).
 */
export function buildManagedServiceNames(state: ControlPlaneState): string[] {
  return buildManagedServices(state);
}
