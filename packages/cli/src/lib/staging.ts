/**
 * CLI-side staging pipeline for Docker Compose operations.
 *
 * Delegates to @openpalm/lib for all control-plane logic. The CLI
 * uses FilesystemAssetProvider (reads from DATA_HOME) and
 * FilesystemRegistryProvider (reads from registry dir).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createState,
  stageArtifacts,
  persistArtifacts,
  buildComposeFileList,
  buildManagedServices,
  buildEnvFiles,
  FilesystemAssetProvider,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';
import { defaultDataHome } from './paths.ts';

/**
 * Ensure all artifacts are staged from CONFIG_HOME/DATA_HOME to STATE_HOME.
 *
 * This is the CLI-side equivalent of the admin's staging pipeline.
 * It uses FilesystemAssetProvider (reads core assets from DATA_HOME,
 * persisted by the install command) rather than Vite bundle imports.
 *
 * Returns a ControlPlaneState usable with fullComposeArgs().
 */
export async function ensureStagedState(): Promise<ControlPlaneState> {
  const dataDir = defaultDataHome();

  // Verify DATA_HOME has core assets (populated by `openpalm install`)
  if (!existsSync(join(dataDir, 'docker-compose.yml'))) {
    throw new Error(
      `Core assets not found in ${dataDir}. Run 'openpalm install' first.`,
    );
  }

  const assets = new FilesystemAssetProvider(dataDir);

  const state = createState();
  state.artifacts = stageArtifacts(state, assets);
  persistArtifacts(state, assets);

  return state;
}

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
