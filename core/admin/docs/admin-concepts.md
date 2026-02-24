# OpenPalm Architecture Concepts

These five concepts — Extensions, Secrets, Channels, Automations, and Gateway — form the complete vocabulary for the admin UI, documentation, API naming, and internal development. For user-facing descriptions of each concept, see [User Concepts](../../../docs/concepts.md).

---

## Extensions

An extension is the umbrella term for all types of [OpenCode](https://opencode.ai/docs/) configuration artifacts that modify what the assistant can do or how it behaves. The underlying OpenCode runtime supports several distinct extension types, each with different capabilities and security characteristics:

| Extension type | What it is | File location |
|---|---|---|
| **Skill** | A markdown behavioral directive loaded on-demand via the native [`skill` tool](https://opencode.ai/docs/skills/). Tells the assistant *how* to approach certain tasks. Skills cannot execute code, make network requests, or access tools -- they influence reasoning only. Each `SKILL.md` requires YAML frontmatter with `name` and `description` fields. Skills have a [permission system](https://opencode.ai/docs/skills/#configure-permissions) (`allow`/`deny`/`ask`) that controls which agents can load them. | `skills/<n>/SKILL.md` |
| **Command** | A markdown or JSON [slash command](https://opencode.ai/docs/commands/) definition. Gives the user a shortcut (`/command-name`) that sends a predefined prompt to the assistant. Commands support argument substitution (`$ARGUMENTS`, positional `$1`/`$2`), shell output injection (`!command`), and file references (`@file`). Frontmatter can specify `agent`, `model`, and `subtask` options. | `commands/<n>.md` |
| **Agent** | A markdown or JSON [agent definition](https://opencode.ai/docs/agents/) that configures a specialized assistant persona. Agents have a `mode` (`primary` for direct interaction via Tab key, `subagent` for delegation via `@mention`). Each agent can define its own tool access policy, model selection, temperature, step limits, permissions, and custom system prompt. OpenCode ships with built-in agents: `build`, `plan`, `general`, and `explore`. | `agents/<n>.md` |
| **Custom Tool** | A TypeScript/JavaScript module that exposes a callable function to the assistant using the `tool()` helper from [`@opencode-ai/plugin`](https://opencode.ai/docs/custom-tools/). The TS definition can invoke scripts in any language (Python, bash, etc.) via `Bun.$`. Tools receive session context (`agent`, `sessionID`, `directory`, `worktree`) and can make network requests, read files, and interact with services. Multiple tools can be exported from a single file. | `tools/<n>.ts` |
| **Plugin** | A TypeScript module that hooks into the [OpenCode lifecycle](https://opencode.ai/docs/plugins/) via event subscriptions (e.g., `tool.execute.before`, `session.idle`, `experimental.session.compacting`). Plugins can intercept, modify, or block tool execution, create additional custom tools via the `tool` helper, inject environment variables, send notifications, and integrate with external services. Plugins can be loaded from local files *or* from npm packages listed in the [`plugin` config array](https://opencode.ai/docs/config/#plugins) -- npm plugins are auto-installed by Bun at startup and cached in `~/.cache/assistant/node_modules/`. | `plugins/<n>.ts` or npm package in config |

> **Note on directory naming:** OpenCode uses [plural directory names](https://opencode.ai/docs/config/#custom-directory) (`skills/`, `agents/`, `commands/`, `tools/`, `plugins/`, `modes/`, `themes/`) as the standard convention. All OpenPalm extension directories use the plural form.

The admin UI manages only plugins (the `plugin[]` list in `opencode.json`). Skills, agents, commands, and tools are managed manually by advanced users in the OpenCode config directory.

---

## Secrets

A secret is a named key/value entry in `secrets.env`. The stack treats `secrets.env` as the single source of truth, and channel config values can reference secrets directly via `${SECRET_NAME}`. The actual secret value never appears in config files; OpenCode uses `{env:VAR_NAME}` interpolation to reference them at runtime. Secret reference validation occurs during stack render/apply — missing keys fail with validation errors.

For API details, see [API Reference — Secrets](../../../dev/docs/api-reference.md#secrets-contract-canonical).

---

## Channels

A channel is a self-contained adapter service that handles the protocol-specific details of receiving messages from users on a particular platform, normalizing them into a standard format, forwarding them through the Gateway for processing, and delivering the response back to the user in the platform's native format.

Every channel, regardless of platform, follows the same contract:

```
User (platform) -> Channel Adapter -> Gateway -> AI Assistant -> Gateway -> Channel Adapter -> User (platform)
```

| Property | Description | Example |
|---|---|---|
| **ID** | Stable identifier | `chat`, `discord`, `voice`, `telegram` |
| **Name** | User-facing display name | "Discord", "Web Chat", "Voice" |
| **Status** | Current state | disabled / enabled / error |
| **Access** | Network visibility | private (local network only) / public (internet-accessible) |
| **Credentials** | Platform-specific secrets needed to operate | Discord bot token, Telegram bot token |
| **Setup guide** | Link to platform documentation for creating bot accounts, etc. | Discord Developer Portal docs |

Access control is a per-channel property. Access changes are applied by updating the reverse proxy routing rules for that channel's endpoint. For the full channel flow and security model, see [Architecture](../../../dev/docs/architecture.md).

---

## Automations

An automation is a scheduled prompt that runs against the AI assistant at a defined frequency without any user trigger.

| Property | Description | Example |
|---|---|---|
| **ID** | Unique identifier (UUID) | `a1b2c3d4-...` |
| **Name** | User-facing label | "Daily Morning Briefing" |
| **Prompt** | The instruction sent to the assistant | "Summarize the top 5 tech headlines and post to the #news Discord channel" |
| **Schedule** | When it runs | Every day at 9:00 AM (stored as `0 9 * * *`) |
| **Status** | Whether it's active | enabled / disabled |

Channels are reactive (respond when a user sends a message); automations are proactive (the assistant acts on its own schedule). For implementation details, see [Architecture — Automations](../../../dev/docs/architecture.md#automations).

---

## Gateway

The Gateway is the central security and routing layer that sits between all channels and the AI assistant. Every message passes through the Gateway — it is the single enforcement point for authentication, rate limiting, input validation, and audit logging.

The Gateway enforces a critical architectural invariant: **no channel can talk to the assistant directly.** This makes it safe to add new channels, enable public access, or install community-contributed adapters.

**Key architectural properties:**
- The Gateway is the *only* service that communicates with the AI assistant on behalf of channels. Channel containers have network access only to the Gateway.
- Each channel has a unique HMAC shared secret, generated at install time and never exposed to users.
- The Gateway is stateless — it does not store messages, sessions, or user data. Audit logs are the only persistent artifact.
- The Gateway does not implement channel-specific logic. It receives a normalized payload and doesn't care whether it came from Discord, Telegram, voice, or chat.

For the full 6-step processing pipeline, see [Architecture — Message processing](../../../dev/docs/architecture.md#message-processing-channel-inbound) and [Security Guide](../../../docs/security.md).
