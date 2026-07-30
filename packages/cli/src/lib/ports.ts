/**
 * Default host ports for OpenPalm services.
 *
 * The host-UI port and its resolution live in `@openpalm/lib`
 * (control-plane/network-contract.ts) so the CLI, Electron, and the UI's own
 * routes share ONE answer — three independent `3880` constants plus inline
 * fallbacks is how the desktop app came to ignore a port a headless install had
 * persisted. This module stays as the CLI's import site.
 */
import { DEFAULT_HOST_UI_PORT, resolveHostUiPort, STACK_DEFAULTS } from '@openpalm/lib';

/** Default host port for the UI server (override via OP_HOST_UI_PORT). */
export const DEFAULT_UI_PORT = DEFAULT_HOST_UI_PORT;

/** Default published host port for the assistant (override via OP_ASSISTANT_PORT). */
export const DEFAULT_ASSISTANT_PORT = STACK_DEFAULTS.ports.assistant;

/**
 * Merge-and-resolve `OP_HOST_UI_PORT`: a persisted-env record (e.g. headless
 * install's stack.env) layered under a live env (live env wins), falling back
 * to {@link DEFAULT_UI_PORT}.
 */
export function resolveHostUiPortFromEnv(
  env: NodeJS.ProcessEnv,
  persistedEnv: Record<string, string>,
): number {
  return resolveHostUiPort(undefined, env, persistedEnv);
}
