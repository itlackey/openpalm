# admin-tools (contributor reference)

This package ships the OpenCode plugin loaded into the admin container's
OpenCode instance. It registers tools that wrap the admin HTTP API so
the admin-side assistant can:

- Inspect platform health and container status
- Start, stop, and restart services through the admin API (no Docker
  socket required in the plugin)
- Read and patch generated artifacts (compose files, env files)
- Inspect the audit log
- Manage installed channels and addons via the registry
- Drive lifecycle operations (install, update, uninstall, upgrade)

The admin assistant's persona, tool usage rules, and safety boundaries
are defined in:

- `core/assistant/opencode/system.md` — system prompt shared by all
  OpenPalm assistants (memory, tools, secrets, built-in skills).
- `core/assistant/opencode/openpalm.md` — instructions for managing the
  stack via the admin API.

When changing admin assistant behaviour or guidance, edit those files.
This `AGENTS.md` is a contributor pointer only and is not loaded by
OpenCode at runtime.
