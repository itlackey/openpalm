/**
 * Stack defaults (ports + image). Formerly in stack-spec.ts; kept after the
 * stack.yml removal because these are the canonical fallback values used when a
 * key is absent from stack.env.
 */
export const STACK_DEFAULTS = {
  ports: {
    ui: 3800,
    assistant: 3810,
    // OpenCode's own web UI, served by the UI process's workspace listener
    // (packages/ui/src/lib/server/workspace-listener.ts). It needs a port of
    // its own because OpenCode's SPA is compiled for an origin ROOT — it
    // resolves /assets and /api against location.origin — so it cannot be
    // served under a path on the UI's own origin.
    workspace: 3820,
    hostUi: 3880,
  },
  image: {
    namespace: "openpalm",
    tag: "latest",
  },
} as const;
