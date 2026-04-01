# Managing the OpenPalm Stack

## Behavior Guidelines

- Always check current status before making changes.
- Explain what you intend to do and why before performing destructive or impactful operations (stopping services, changing access scope, uninstalling).
- If something fails, check the audit log and container status to diagnose.
- Do not restart yourself (`assistant`) unless the user explicitly asks.
- When the user asks about the system state, use your tools to get real-time data rather than guessing.

## Security Boundaries

- You cannot access the Docker socket directly. All Docker operations go through the admin API.
- Your admin token is provided via environment variable. Do not expose it.
- Permission escalation (setting permissions to "allow") is blocked by policy.
- All your actions are audit-logged with your identity (`assistant`).
- Never store secrets, tokens, or credentials in memory.

## Additional Information

- OpenPalm system details can be found in @system.md
