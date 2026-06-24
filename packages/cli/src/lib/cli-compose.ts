/**
 * CLI Docker Compose orchestration.
 *
 * Delegates to @openpalm/lib for compose file resolution,
 * CLI argument construction, and preflight checks.
 */
import {
  buildComposeCliArgs,
  buildComposeOptions,
  composePreflight,
  resolveComposeProjectName,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';
import { runDockerCompose } from './docker.ts';

/**
 * Run a compose command that does NOT mutate state (e.g. logs, ps, status).
 * Skips preflight validation since these commands are read-only.
 */
export async function runComposeReadOnly(
  state: ControlPlaneState,
  composeSubArgs: string[],
): Promise<void> {
  const composeArgs = buildComposeCliArgs(state);
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
      // A missing secret/asset file means OP_HOME is incomplete — usually a home
      // behind the running platform (secrets are written only by install/update,
      // not self-healed on a plain command). Point the user at the repair path
      // instead of leaving them with a raw compose "file not found" error.
      const stderr = preflight.stderr ?? "";
      const looksLikeMissingFile = /secret/i.test(stderr)
        && /(not found|no such file|does not exist|cannot find)/i.test(stderr);
      const guidance = looksLikeMissingFile
        ? `\n\nThis usually means your OpenPalm home is missing files. Run \`openpalm update\` to repair it, then try again.`
        : "";
      throw new Error(
        `Compose preflight failed: ${stderr}\n` +
        `Resolved command: docker compose ${fileArgs} --project-name ${projectName} ${envArgs} config --quiet\n` +
        `Files: ${files.join(', ')}\n` +
        `Env files: ${envFiles.join(', ')}\n` +
        `Project: ${projectName}` +
        guidance,
      );
    }
  }

  const composeArgs = buildComposeCliArgs(state);
  await runDockerCompose([...composeArgs, ...composeSubArgs]);
}
