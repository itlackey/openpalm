/**
 * Stack defaults (ports + image). Formerly in stack-spec.ts; kept after the
 * stack.yml removal because these are the canonical fallback values used when a
 * key is absent from stack.env.
 */
export const SPEC_DEFAULTS = {
  ports: {
    assistant: 3800,
    hostUi: 3880,
    assistantSsh: 2222,
  },
  image: {
    namespace: "openpalm",
    tag: "latest",
  },
} as const;
