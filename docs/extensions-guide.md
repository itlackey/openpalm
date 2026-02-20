# Extensions Guide (Simplified): Admin manages plugins, advanced users manage files

OpenPalm now treats **extensions in Admin/CLI as plugins only**.

## What Admin manages

Admin UI/API/CLI (`openpalm extensions ...`) only does one thing:

- Add/remove entries in `plugin[]` in the mounted OpenCode user config.
- Restart `opencode-core` so plugin changes apply.

This keeps extension management simple and predictable.

## What Admin does not manage

OpenCode content types such as:

- skills
- agents
- commands
- tools

are **not installed/uninstalled by OpenPalm Admin**.

## Manual management for advanced users

If you want to add non-plugin OpenCode content, manage it directly on the host in your OpenCode data mount:

- `${OPENPALM_DATA_HOME}/opencode/.config/opencode/skills/`
- `${OPENPALM_DATA_HOME}/opencode/.config/opencode/agents/`
- `${OPENPALM_DATA_HOME}/opencode/.config/opencode/commands/`
- `${OPENPALM_DATA_HOME}/opencode/.config/opencode/tools/`

For local plugins, place files in:

- `${OPENPALM_DATA_HOME}/opencode/.config/opencode/plugins/`

and add them to:

- `${OPENPALM_DATA_HOME}/opencode/.config/opencode/opencode.json` -> `plugin[]`

## Why this change

This refactor intentionally reduces complexity:

- one extension abstraction in admin flows: **plugin**
- clearer operator expectations
- less UI/API surface area to maintain
- keeps advanced OpenCode customization available without blocking power users
