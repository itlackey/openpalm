/**
 * Stack defaults (ports + image). Formerly in stack-spec.ts; kept after the
 * stack.yml removal because these are the canonical fallback values used when a
 * key is absent from stack.env.
 */
export const STACK_DEFAULTS = {
  ports: {
    ui: 3800,
    assistant: 3810,
    hostUi: 3880,
  },
  image: {
    namespace: "openpalm",
    tag: "latest",
  },
} as const;
