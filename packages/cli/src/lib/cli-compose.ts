/**
 * CLI Docker Compose orchestration.
 *
 * Delegates to @openpalm/lib for compose file resolution, CLI argument
 * construction, preflight checks, the preflight error message, AND the
 * stdio-inheriting compose invocation — the CLI keeps no compose logic of its
 * own beyond wiring the pieces together.
 */
import {
  buildComposeCliArgs,
  buildComposeOptions,
  buildComposePreflightError,
  composePreflight,
  composeUpTimeoutMs,
  dockerBin,
  ensureDockerReady,
  mapDockerError,
  runComposeStreaming,
  runHomeMigrations,
} from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';

/**
 * Run a compose command that does NOT mutate state (e.g. logs, ps, status).
 * Skips preflight validation since these commands are read-only. No timeout:
 * interactive follows (`logs -f`) legitimately run unbounded.
 */
export async function runComposeReadOnly(
  state: ControlPlaneState,
  composeSubArgs: string[],
): Promise<void> {
  const composeArgs = buildComposeCliArgs(state);
  await runComposeStreaming([...composeArgs, ...composeSubArgs]);
}

/**
 * Run compose preflight validation, then execute the compose command.
 * This is the canonical CLI mutation path — all compose operations
 * that modify state must go through this function.
 *
 * Preflight can be bypassed by setting OP_SKIP_COMPOSE_PREFLIGHT=1 (e.g. in tests).
 * The invocation carries lib's `up` timeout budget so a first install extracting
 * multi-GB images is bounded exactly like the capturing `composeUp` path.
 */
export async function runComposeWithPreflight(
  state: ControlPlaneState,
  composeSubArgs: string[],
): Promise<void> {
  runHomeMigrations(state.homeDir);
  const options = buildComposeOptions(state);

  // D1: a single "is Docker actually usable right now" readiness check ahead
  // of every day-2 lifecycle mutation (start/stop/restart/rollback/addon
  // enable/…). Catches the missing-binary and stopped-daemon cases with a
  // friendly, non-blank message BEFORE they can surface as the raw (sometimes
  // literally blank) `docker compose config --quiet` preflight error below —
  // `docker compose config` never contacts the daemon, so a stopped daemon
  // would otherwise sail through it. Gated on the same OP_SKIP_COMPOSE_PREFLIGHT
  // env used below so tests that fully mock this function stay green.
  if (!process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const ready = await ensureDockerReady();
    if (!ready.ok) throw new Error(ready.message);
  }

  // Preflight: validate compose merge before mutation. Pass the FULL options
  // (files, env files, AND profiles) — matching lib's own runPreflight — so
  // profile-gated services are validated and the error message reports the same
  // resolved command lib would.
  if (options.files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const preflight = await composePreflight(options);
    if (!preflight.ok) {
      // Belt-and-suspenders: ensureDockerReady() above should already have
      // caught a missing/stopped Docker, but if Docker vanishes between the
      // two checks (or a future caller skips the preamble), this preflight's
      // stderr can still be EMPTY — a bare spawn-level ENOENT carries no
      // stderr at all (docker.ts's toDockerResult). Route the raw stderr
      // (synthesizing a short errno-bearing string from `errorCode` when both
      // are absent) through mapDockerError so the message is NEVER blank.
      const rawStderr = preflight.stderr && preflight.stderr.length > 0
        ? preflight.stderr
        : preflight.errorCode
          ? `spawn ${dockerBin()} ${preflight.errorCode}`
          : '';
      // Single source of truth for the message shape (lib) — includes the
      // resolved command with --profile args AND the missing-secret repair
      // guidance, wrapped around the friendly, never-blank mapped stderr.
      throw new Error(buildComposePreflightError(options, mapDockerError(rawStderr).message));
    }
  }

  const composeArgs = buildComposeCliArgs(state);
  await runComposeStreaming([...composeArgs, ...composeSubArgs], {
    timeoutMs: composeUpTimeoutMs(),
  });
}
