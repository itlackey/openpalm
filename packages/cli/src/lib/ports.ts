/**
 * Default host ports for OpenPalm services, defined once so the CLI does not
 * scatter magic numbers across install/run sites. Each is overridable via the
 * matching environment variable at the call site.
 */

/** Default host port for the UI server (override via OP_HOST_UI_PORT). */
export const DEFAULT_UI_PORT = 3880;

/** Default published host port for the assistant (override via OP_ASSISTANT_PORT). */
export const DEFAULT_ASSISTANT_PORT = 3810;

/**
 * Merge-and-resolve `OP_HOST_UI_PORT`: a persisted-env record (e.g. headless
 * install's stack.env) layered under a live env (live env wins), falling back
 * to {@link DEFAULT_UI_PORT}. Hoisted here (review finding U2) so
 * ui-server.ts's `resolveUiServePort` shares ONE implementation instead of
 * byte-duplicating it — it already imports this module, which imports it back,
 * so there is no import-cycle reason to keep the logic separate.
 */
export function resolveHostUiPortFromEnv(
  env: NodeJS.ProcessEnv,
  persistedEnv: Record<string, string>,
): number {
  const merged = { ...persistedEnv, ...env };
  return Number(merged.OP_HOST_UI_PORT) || DEFAULT_UI_PORT;
}
