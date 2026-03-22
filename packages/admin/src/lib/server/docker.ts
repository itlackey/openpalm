/**
 * Docker Compose CLI wrapper — re-exported from @openpalm/lib
 * with preflight-enforcing wrappers for mutation operations.
 */
import type { DockerResult } from "@openpalm/lib";
import {
  checkDocker as _checkDocker,
  checkDockerCompose as _checkDockerCompose,
  composeUp as _composeUp,
  composeDown as _composeDown,
  composeRestart as _composeRestart,
  composeStop as _composeStop,
  composeStart as _composeStart,
  composePs as _composePs,
  composeLogs as _composeLogs,
  composePullService as _composePullService,
  composePull as _composePull,
  composeStats as _composeStats,
  getDockerEvents as _getDockerEvents,
  selfRecreateAdmin as _selfRecreateAdmin,
  composePreflight,
  resolveComposeProjectName,
} from "@openpalm/lib";

export type { DockerResult };

// Read-only operations — no preflight needed
export const checkDocker = _checkDocker;
export const checkDockerCompose = _checkDockerCompose;
export const composePs = _composePs;
export const composeLogs = _composeLogs;
export const composeStats = _composeStats;
export const getDockerEvents = _getDockerEvents;

// ── Preflight enforcement ─────────────────────────────────────────────

type ComposeOptions = { files: string[]; envFiles?: string[] };

async function runPreflight(options: ComposeOptions): Promise<void> {
  if (options.files.length === 0 || process.env.OP_SKIP_COMPOSE_PREFLIGHT) return;
  const result = await composePreflight(options);
  if (!result.ok) {
    const project = resolveComposeProjectName();
    const fileArgs = options.files.map((f) => `-f ${f}`).join(" ");
    const envArgs = (options.envFiles ?? []).map((f) => `--env-file ${f}`).join(" ");
    throw new Error(
      `Compose preflight failed: ${result.stderr}\n` +
      `Resolved command: docker compose ${fileArgs} --project-name ${project} ${envArgs} config --quiet`
    );
  }
}

// Mutation operations — preflight runs first

export async function composeUp(
  options: Parameters<typeof _composeUp>[0]
): Promise<DockerResult> {
  await runPreflight(options);
  return _composeUp(options);
}

export async function composeDown(
  options: Parameters<typeof _composeDown>[0]
): Promise<DockerResult> {
  await runPreflight(options);
  return _composeDown(options);
}

export async function composeRestart(
  services: string[],
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  await runPreflight(options);
  return _composeRestart(services, options);
}

export async function composeStop(
  services: string[],
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  await runPreflight(options);
  return _composeStop(services, options);
}

export async function composeStart(
  services: string[],
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  await runPreflight(options);
  return _composeStart(services, options);
}

export async function composePullService(
  service: string,
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  await runPreflight(options);
  return _composePullService(service, options);
}

export async function composePull(
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  await runPreflight(options);
  return _composePull(options);
}

export function selfRecreateAdmin(
  options: { files: string[]; envFiles?: string[] }
): void {
  // selfRecreateAdmin is fire-and-forget (spawns detached process).
  // Preflight is synchronous-incompatible here but the compose files
  // were already validated by the lifecycle preflight in reconcileCore().
  _selfRecreateAdmin(options);
}
