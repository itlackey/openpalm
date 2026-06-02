# assistant-tools (contributor reference)

This package ships the OpenCode plugin loaded into the OpenPalm assistant
container. It registers one direct tool:

- `load_vault` — loads user secrets (prefers the shared akm `env:user`
  file at `knowledge/env/user.env`, falls back to `/etc/env/user.env`).

Everything else the assistant uses (memory, skills, lessons, agents,
workflows, env, secrets) comes from the `akm-opencode` plugin via the `akm_*`
tools — there is no separate memory service.

The assistant's persona, memory guidelines, secret rules, install paths,
and built-in skill list are defined in:

- `.openpalm/config/assistant/system.md` — system prompt (memory, tools,
  secrets, built-in skills).
- `.openpalm/config/assistant/openpalm.md` — operational guidelines and
  isolation invariants. Includes the **install-location matrix** the
  assistant uses to decide between `$HOME`-based installers and `$HOME/.local`
  prefix installs (persist automatically), `/opt/persistent` for global-prefix
  escape hatches, and `apt` (ephemeral — survives restart only). The
  assistant has no stack management capability; only the host CLI and
  admin UI can manage the stack.

Both files are seeded from this repo into `~/.openpalm/config/assistant/`
during install and bind-mounted into the container at
`/etc/opencode/` (resolved via `OPENCODE_CONFIG_DIR`).

When changing assistant behavior or guidance, edit those two files in
`.openpalm/config/assistant/`. Changes take effect on the next assistant
container restart.

This `AGENTS.md` exists only as a contributor pointer and is not loaded
by OpenCode at runtime.
