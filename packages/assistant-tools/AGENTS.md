# assistant-tools (contributor reference)

This package ships the OpenCode plugin loaded into the OpenPalm assistant
container. It registers two direct tools:

- `load_vault` — loads user secrets (prefers the shared akm `vault:user`
  store, falls back to `/etc/vault/user.env`).
- `health-check` — reports the health of core platform services.

Everything else the assistant uses (memory, skills, lessons, agents,
workflows, vaults) comes from the `akm-opencode` plugin via the `akm_*`
tools — there is no separate memory service.

The assistant's persona, memory guidelines, secret rules, install paths,
and built-in skill list are defined in:

- `.openpalm/config/assistant/system.md` — system prompt (memory, tools,
  secrets, built-in skills).
- `.openpalm/config/assistant/openpalm.md` — operational guidelines and
  isolation invariants. Includes the **install-location matrix** the
  assistant uses to decide between `$HOME`-based installers (persist
  automatically), `/opt/persistent` (named volume, persists across
  upgrades), and `apt` (ephemeral — survives restart only). The
  assistant has no stack management capability; only the host CLI and
  admin UI can manage the stack.

Both files are seeded from this repo into `~/.openpalm/config/assistant/`
during install and bind-mounted into the container at
`/etc/openpalm/assistant/` (resolved via `OPENCODE_CONFIG_DIR`).

When changing assistant behavior or guidance, edit those two files in
`.openpalm/config/assistant/`. Changes take effect on the next assistant
container restart.

This `AGENTS.md` exists only as a contributor pointer and is not loaded
by OpenCode at runtime.
