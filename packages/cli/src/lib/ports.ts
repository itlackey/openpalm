/**
 * Default host ports for OpenPalm services, defined once so the CLI does not
 * scatter magic numbers across install/run sites. Each is overridable via the
 * matching environment variable at the call site.
 */

/** Default host port for the UI server (override via OP_HOST_UI_PORT). */
export const DEFAULT_UI_PORT = 3880;

/** Default published host port for the assistant (override via OP_ASSISTANT_PORT). */
export const DEFAULT_ASSISTANT_PORT = 3800;

/**
 * Default host port for the @openpalm/client static app server (override via
 * OP_CLIENT_PORT). STABLE by design: the localhost PWA identity is
 * origin-including-port (plan ui-runtime-modes-plan.md §6.10), so this number
 * must not drift between releases.
 */
export const DEFAULT_CLIENT_PORT = 3890;
