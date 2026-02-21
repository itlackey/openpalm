# Extensions Guide

OpenPalm supports all OpenCode extension types: **plugins**, **agents**, **commands**, **skills**, **tools**, and **providers**. These extensions add new capabilities to your assistant — behavioral rules, slash commands, specialized agent personas, custom callable tools, and lifecycle plugins that hook into the runtime.

## Extension types

| Type | What it does | Risk |
|---|---|---|
| **Skill** | A Markdown file that guides how the assistant reasons and responds. No code execution. | Lowest |
| **Command** | A Markdown slash command (`/command-name`) that sends a predefined prompt to the assistant. | Low |
| **Agent** | A Markdown file defining a specialized assistant persona with its own tool access and system prompt. | Medium |
| **Tool** | A TypeScript module exposing a callable function to the assistant. Can make network requests, read files, and interact with services. | Medium-high |
| **Plugin** | A TypeScript module that hooks into the OpenCode lifecycle. Can intercept, block, or augment tool execution and inject context. | Highest |
| **Provider** | An AI provider configuration (OpenAI, Anthropic, or any OpenAI-compatible endpoint) with model and API key settings. | — |

## What the admin UI and CLI manage

The admin UI and CLI (`openpalm extensions ...`) manage **npm plugins** — entries in the `plugin[]` array of `opencode.json`. Installing a plugin adds it to this array and restarts `opencode-core` so the change takes effect. OpenCode then fetches the package via `bun install` at startup.

```bash
openpalm extensions install --plugin @scope/plugin-name
openpalm extensions list
openpalm extensions uninstall --plugin @scope/plugin-name
```

## Manual management for advanced users

Skills, agents, commands, and tools are managed directly on the host in the OpenCode config directory:

- `${OPENPALM_DATA_HOME}/openpalm/.config/opencode/skills/`
- `${OPENPALM_DATA_HOME}/openpalm/.config/opencode/agents/`
- `${OPENPALM_DATA_HOME}/openpalm/.config/opencode/commands/`
- `${OPENPALM_DATA_HOME}/openpalm/.config/opencode/tools/`

For local plugins, place files in:

- `${OPENPALM_DATA_HOME}/openpalm/.config/opencode/plugins/`

and add them to the `plugin[]` array in:

- `${OPENPALM_DATA_HOME}/openpalm/.config/opencode/opencode.json`

Changes take effect after restarting `opencode-core`.

## Providers

Providers are configured via the admin UI under Settings, or by editing the `opencode.json` config directly. Each provider entry specifies a base URL and API key, which are stored in `secrets.env` and referenced via `{env:VAR_NAME}` interpolation in the config file. The admin API also supports listing, creating, updating, and deleting providers at `/admin/providers`.

## Built-in extensions

OpenPalm ships with built-in extensions baked into the `opencode-core` container image:

- **`openmemory-http` plugin** — memory recall injection and post-turn writeback via OpenMemory's REST API
- **`policy-and-telemetry` plugin** — secret detection in tool arguments and structured audit logging
- **`memory` skill** — behavioral rules for recall-first responses and explicit-save-only memory policy
- **`memory-query`, `memory-save`, `health-check` tools** — callable functions for memory operations and health checks
- **`/memory-recall`, `/memory-save`, `/health` commands** — slash command shortcuts

See the [Extensions Reference](reference/extensions-reference.md) for full technical details on each built-in extension.
