# assistant-tools (contributor reference)

This package ships the OpenCode plugin loaded into the OpenPalm assistant
container. It registers two direct tools:

- `load_vault` — loads user secrets (prefers the shared akm `vault:user`
  store, falls back to `/etc/vault/user.env`).
- `health-check` — reports the health of core platform services.

Everything else the assistant uses (memory, skills, lessons, agents,
workflows, vaults) comes from the `akm-opencode` plugin via the `akm_*`
tools — there is no separate memory service.

The assistant's persona, memory guidelines, secret rules, and built-in
skill list are defined in:

- `core/assistant/opencode/system.md` — system prompt (memory, tools,
  secrets, built-in skills).
- `core/assistant/opencode/openpalm.md` — operational guidelines and
  isolation invariants (the assistant has no stack management capability;
  only the host CLI and admin UI can manage the stack).

When changing assistant behavior or guidance, edit those two files.
This `AGENTS.md` exists only as a contributor pointer and is not loaded
by OpenCode at runtime.
