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
  migrateLegacyBindAddresses,
  migrateLegacyDefaultPorts,
  runComposeStreaming,
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
  migrateLegacyDefaultPorts(state.homeDir);
  migrateLegacyBindAddresses(state.homeDir);
  const options = buildComposeOptions(state);

  // Preflight: validate compose merge before mutation. Pass the FULL options
  // (files, env files, AND profiles) — matching lib's own runPreflight — so
  // profile-gated services are validated and the error message reports the same
  // resolved command lib would.
  if (options.files.length > 0 && !process.env.OP_SKIP_COMPOSE_PREFLIGHT) {
    const preflight = await composePreflight(options);
    if (!preflight.ok) {
      // Single source of truth for the message (lib) — includes the resolved
      // command with --profile args AND the missing-secret repair guidance.
      throw new Error(buildComposePreflightError(options, preflight.stderr ?? ''));
    }
  }

  const composeArgs = buildComposeCliArgs(state);
  await runComposeStreaming([...composeArgs, ...composeSubArgs], {
    timeoutMs: composeUpTimeoutMs(),
  });
}
