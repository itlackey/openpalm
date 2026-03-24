/**
 * CLI Docker Compose orchestration.
 *
 * Delegates to @openpalm/lib for compose file resolution,
 * CLI argument construction, and preflight checks.
 */
import {
  buildManagedServices,
  buildComposeCliArgs,
  buildComposeOptions,
  composePreflight,
  resolveComposeProjectName,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';
import { runDockerCompose } from './docker.ts';

/**
 * Build the full list of docker compose CLI arguments for a given state.
 *
 * Returns: ['--project-name', 'openpalm', '-f', '...', '--env-file', '...']
 */
export function fullComposeArgs(state: ControlPlaneState): string[] {
  return buildComposeCliArgs(state);
}

/**
 * Build the list of managed service names (used for targeted `up` commands).
 * Uses compose-derived discovery when Docker is available.
 */
export async function buildManagedServiceNames(state: ControlPlaneState): Promise<string[]> {
  return buildManagedServices(state);
}

/**
 * Run a compose command that does NOT mutate state (e.g. logs, ps, status).
 * Skips preflight validation since these commands are read-only.
 */
export async function runComposeReadOnly(
  state: ControlPlaneState,
  composeSubArgs: string[],
): Promise<void> {
  const composeArgs = fullComposeArgs(state);
  await runDockerCompose([...composeArgs, ...composeSubArgs]);
}

/**
 * Run compose preflight validation, then execute the compose command.
 * This is the canonical CLI mutation path — all compose operations
 * that modify state must go through this function.
 *
 * Preflight can be bypassed by setting OP_SKIP_COMPOSE_PREFLIGHT=1 (e.g. in tests).
 */
export async function runComposeWithPreflight(
  state: ControlPlaneState,
  composeSubArgs: string[],
): Promise<void> {
  const { files, envFiles } = buildComposeOptions(state);

  // Preflight: validate compose merge before mutation
  if (files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const preflight = await composePreflight({ files, envFiles });
    if (!preflight.ok) {
      const projectName = resolveComposeProjectName();
      const fileArgs = files.map(f => `-f ${f}`).join(' ');
      const envArgs = envFiles.map(f => `--env-file ${f}`).join(' ');
      throw new Error(
        `Compose preflight failed: ${preflight.stderr}\n` +
        `Resolved command: docker compose ${fileArgs} --project-name ${projectName} ${envArgs} config --quiet\n` +
        `Files: ${files.join(', ')}\n` +
        `Env files: ${envFiles.join(', ')}\n` +
        `Project: ${projectName}`,
      );
    }
  }

  const composeArgs = fullComposeArgs(state);
  await runDockerCompose([...composeArgs, ...composeSubArgs]);
}
