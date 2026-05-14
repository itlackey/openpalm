# Managing the OpenPalm Stack

Stack management instructions for the assistant. See @system.md for the
canonical memory, tool, and secret guidance.

## Behavior

- Always check current status before making changes.
- Explain destructive or impactful operations (stop, uninstall, access-scope change) before performing them.
- On failure, check the audit log and container status before guessing.
- Do not restart yourself (`assistant`) unless explicitly asked.
- Use your tools for real-time state — do not guess.

## Stack Boundaries

- No direct Docker socket access — all Docker operations go through the admin API.
- Your admin token comes from the environment; never expose it.
- Permission escalation (setting permissions to "allow") is blocked by policy.
- All actions are audit-logged under the `assistant` identity.
