/**
 * Default host ports for OpenPalm services, defined once so the CLI does not
 * scatter magic numbers across install/run sites. Each is overridable via the
 * matching environment variable at the call site.
 */

/** Default host port for the UI server (override via OP_HOST_UI_PORT). */
export const DEFAULT_UI_PORT = 3880;

/** Default published host port for the assistant (override via OP_ASSISTANT_PORT). */
export const DEFAULT_ASSISTANT_PORT = 3800;
