## Current control-plane status

Admin applies stack changes directly using allowlisted compose operations, while Stack Spec remains the source of truth for generated compose/caddy/channel/env artifacts.

Secret handling remains on the existing secret manager model (no standalone secret-map file), with expanded scoped env rendering and validation.

# OpenPalm Architecture Concepts

This document defines the core concepts that make up the OpenPalm platform. Each concept is described from three perspectives: what it means to the user, what it represents architecturally, and how it works at the implementation level.

These five concepts -- Extensions, Connections, Channels, Automations, and Gateway -- form the complete vocabulary for the admin UI, documentation, API naming, and internal development.

---

## Extensions

### What the user sees

Extensions are things you can add to your assistant to give it new abilities. An extension might teach the assistant a new behavior ("always check memory before answering"), give it a new tool ("search the web"), add a custom slash command, or change how it processes requests. Users browse extensions in a gallery, read a name and description, and click to enable or disable them. They never need to know whether something is a plugin, skill, tool, agent, or command -- it's just an extension that does what the description says.

### What it represents

An extension is the umbrella term for all types of [OpenCode](https://opencode.ai/docs/) configuration artifacts that modify what the assistant can do or how it behaves. The underlying OpenCode runtime supports several distinct extension types, each with different capabilities and security characteristics:

| Extension type | What it is | File location | Risk profile |
|---|---|---|---|
| **Skill** | A markdown behavioral directive loaded on-demand via the native [`skill` tool](https://opencode.ai/docs/skills/). Tells the assistant *how* to approach certain tasks. Skills cannot execute code, make network requests, or access tools -- they influence reasoning only. Each `SKILL.md` requires YAML frontmatter with `name` and `description` fields. Skills have a [permission system](https://opencode.ai/docs/skills/#configure-permissions) (`allow`/`deny`/`ask`) that controls which agents can load them. | `skills/<n>/SKILL.md` | Lowest -- text-only influence on reasoning |
| **Command** | A markdown or JSON [slash command](https://opencode.ai/docs/commands/) definition. Gives the user a shortcut (`/command-name`) that sends a predefined prompt to the assistant. Commands support argument substitution (`$ARGUMENTS`, positional `$1`/`$2`), shell output injection (`!command`), and file references (`@file`). Frontmatter can specify `agent`, `model`, and `subtask` options. | `commands/<n>.md` | Low -- triggers a prompt, no code execution |
| **Agent** | A markdown or JSON [agent definition](https://opencode.ai/docs/agents/) that configures a specialized assistant persona. Agents have a `mode` (`primary` for direct interaction via Tab key, `subagent` for delegation via `@mention`). Each agent can define its own tool access policy, model selection, temperature, step limits, permissions, and custom system prompt. OpenCode ships with built-in agents: `build`, `plan`, `general`, and `explore`. | `agents/<n>.md` | Medium -- can restrict or grant tool access |
| **Custom Tool** | A TypeScript/JavaScript module that exposes a callable function to the assistant using the `tool()` helper from [`@opencode-ai/plugin`](https://opencode.ai/docs/custom-tools/). The TS definition can invoke scripts in any language (Python, bash, etc.) via `Bun.$`. Tools receive session context (`agent`, `sessionID`, `directory`, `worktree`) and can make network requests, read files, and interact with services. Multiple tools can be exported from a single file. | `tools/<n>.ts` | Medium to high -- executes code at runtime |
| **Plugin** | A TypeScript module that hooks into the [OpenCode lifecycle](https://opencode.ai/docs/plugins/) via event subscriptions (e.g., `tool.execute.before`, `session.idle`, `experimental.session.compacting`). Plugins can intercept, modify, or block tool execution, create additional custom tools via the `tool` helper, inject environment variables, send notifications, and integrate with external services. Plugins can be loaded from local files *or* from npm packages listed in the [`plugin` config array](https://opencode.ai/docs/config/#plugins) -- npm plugins are auto-installed by Bun at startup and cached in `~/.cache/opencode/node_modules/`. | `plugins/<n>.ts` or npm package in config | Highest -- can observe and modify all tool calls |

> **Note on directory naming:** OpenCode uses [plural directory names](https://opencode.ai/docs/config/#custom-directory) (`skills/`, `agents/`, `commands/`, `tools/`, `plugins/`, `modes/`, `themes/`) as the standard convention. All OpenPalm extension directories use the plural form.

The admin UI manages only plugins (the `plugin[]` list in `opencode.json`). Skills, agents, commands, and tools are managed manually by advanced users in the OpenCode config directory.

### How it works

Extensions are managed through the OpenCode [configuration directory](https://opencode.ai/docs/config/#custom-directory), which is a volume mounted into the `opencode-core` container. OpenCode supports a custom config directory via the `OPENCODE_CONFIG_DIR` environment variable -- this directory is searched for `agents/`, `commands/`, `modes/`, `plugins/`, `skills/`, `tools/`, and `themes/` subdirectories just like the standard `.opencode` directory, and follows the same structure. The custom directory is loaded after the global config and `.opencode` directories, so it can override their settings.

Configuration files across all sources are [merged together](https://opencode.ai/docs/config/#precedence-order), not replaced. The full precedence order is:

1. Remote config (from `.well-known/opencode`) -- organizational defaults
2. Global config (`~/.config/opencode/opencode.json`) -- user preferences
3. Custom config (`OPENCODE_CONFIG` env var) -- custom overrides
4. Project config (`opencode.json` in project) -- project-specific settings
5. `.opencode` directories -- agents, commands, plugins
6. Inline config (`OPENCODE_CONFIG_CONTENT` env var) -- runtime overrides

The install/enable lifecycle for plugins works as follows:

1. **User provides a plugin npm package ID** through the admin UI or API.

2. **Admin service adds the plugin to `opencode.json`:**
   - The npm package name (e.g., `"opencode-helicone-session"` or `"@my-org/custom-plugin"`) is added to the `plugin` array in `opencode.json`. npm plugins are [installed automatically by Bun](https://opencode.ai/docs/plugins/#how-plugins-are-installed) at startup and cached in `~/.cache/opencode/node_modules/`.
   - *Plugin load order:* Global config plugins -> project config plugins -> global plugin directory -> project/custom plugin directory. Duplicate npm packages with the same name and version are loaded once.

3. **Admin tells the admin to restart `opencode-core`** -- the next session picks up the changed configuration directory and/or the updated `opencode.jsonc`.

4. **Uninstall reverses the process** -- remove the file from the config directory or remove the entry from `opencode.jsonc`, then restart.

The configuration directory mount is the key architectural element. It means the admin service never needs to exec into the opencode-core container or modify its image. It only writes files to a shared volume and edits a JSON config file.

**Extension management** in the admin UI is limited to plugins (the `plugin[]` list in `opencode.json`). Skills, agents, commands, and tools are managed manually by advanced users in the OpenCode config directory.

**Relevant OpenCode documentation:**
- [Config overview and precedence](https://opencode.ai/docs/config/)
- [Agent Skills](https://opencode.ai/docs/skills/)
- [Commands](https://opencode.ai/docs/commands/)
- [Agents](https://opencode.ai/docs/agents/)
- [Custom Tools](https://opencode.ai/docs/custom-tools/)
- [Plugins](https://opencode.ai/docs/plugins/)
- [Tools (built-in)](https://opencode.ai/docs/tools/)
- [Permissions](https://opencode.ai/docs/permissions/)

---

## Secrets and credential references

> **Implementation Status:** Secrets are managed as key/value entries in `secrets.env`; channel config values in stack-spec reference secrets directly with `${SECRET_NAME}` when needed.

### What the user sees

Secrets are where you manage the credentials and runtime keys used by channels and services. Users can create/update key-value entries (for example `OPENAI_API_KEY`, `DISCORD_BOT_TOKEN`) and see whether each key is configured and where it is referenced.

### What it represents

A secret is a named key/value entry in `secrets.env`. The stack treats `secrets.env` as the single source of truth, and channel config values in stack-spec can reference secrets directly via `${SECRET_NAME}`.

### How it works

Secrets are stored in a central secrets file (`secrets.env`) that is mounted as a volume accessible to services that need credentials. The admin service manages this file through a structured API -- users never see or edit the env file directly.

The lifecycle:

1. **User creates or updates secret keys** through the admin UI by entering key/value pairs.

2. **Admin service writes the credentials** to `secrets.env` using user-selected secret keys:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ANTHROPIC_ENDPOINT=https://api.anthropic.com
   GITHUB_TOKEN=ghp_...
   OPENAI_API_KEY=sk-...
   OPENAI_ENDPOINT=https://api.openai.com/v1
   ```

3. **Admin validates secret usage from stack-spec channel config** and reports where each secret key is referenced for safe rotation/deletion workflows.

4. **Runtime artifacts are rendered directly from stack-spec + secrets.env.** During render/apply, `${SECRET_NAME}` tokens in channel config are resolved into generated env files; unresolved references fail validation.

5. **OpenCode provider configuration** is updated in `opencode.jsonc` to reference resolved environment variable names via [env var interpolation](https://opencode.ai/docs/config/#env-vars) (e.g., `"apiKey": "{env:ANTHROPIC_API_KEY}"`). This means the actual secret never appears in the config file. OpenCode's config supports `{env:VAR_NAME}` syntax for referencing environment variables and `{file:./path}` syntax for referencing file contents.

The key design principle: credentials are written to exactly one file and referenced everywhere else by environment variable name. The admin UI provides the abstraction layer that lets users think in terms of "my Anthropic account" rather than "which env var holds my API key."

**Secret reference validation** -- during stack render/apply, referenced secret keys must exist in `secrets.env`; missing keys return validation errors before applying changes.

---

## Channels

### What the user sees

Channels are the ways you can talk to your assistant outside of the admin panel. You might enable a Discord channel so the assistant responds in your Discord server, a Telegram channel for mobile messaging, a voice channel for speaking to it, or a web chat channel for embedding in a website. Each channel has its own setup flow -- Discord asks for a bot token, Telegram asks for a bot token, voice asks for a speech endpoint -- and once enabled, shows a status indicator and an access toggle (private to your network, or accessible from the internet).

### What it represents

A channel is a self-contained adapter service that handles the protocol-specific details of receiving messages from users on a particular platform, normalizing them into a standard format, forwarding them through the Gateway for processing, and delivering the response back to the user in the platform's native format.

Every channel, regardless of platform, follows the same contract:

```
User (platform) -> Channel Adapter -> Gateway -> AI Assistant -> Gateway -> Channel Adapter -> User (platform)
```

A channel has these properties:

| Property | Description | Example |
|---|---|---|
| **ID** | Stable identifier | `chat`, `discord`, `voice`, `telegram` |
| **Name** | User-facing display name | "Discord", "Web Chat", "Voice" |
| **Status** | Current state | disabled / enabled / error |
| **Access** | Network visibility | private (local network only) / public (internet-accessible) |
| **Credentials** | Platform-specific secrets needed to operate | Discord bot token, Telegram bot token |
| **Setup guide** | Link to platform documentation for creating bot accounts, etc. | Discord Developer Portal docs |

Access control is a per-channel property. A user might keep Discord public (so the bot is reachable from Discord's servers) while keeping the web chat private (only accessible from their home network). Access changes are applied by updating the reverse proxy routing rules for that channel's endpoint.

### How it works

Each channel runs as a dedicated container in the Docker Compose stack. The container runs a lightweight Bun HTTP server that implements the adapter pattern:

**Inbound flow:**
1. An external event arrives (HTTP webhook from Discord/Telegram, a POST to the chat endpoint, audio from the voice pipeline).
2. The channel adapter normalizes the event into a standard `ChannelMessage` payload: `{ userId, channel, text, metadata, nonce, timestamp }`.
3. The adapter signs the payload with an HMAC shared secret (unique per channel, generated at install time) and forwards it to the Gateway at `/channel/inbound`.
4. The Gateway validates the signature, rate-limits the request, runs it through the intake validation agent, and forwards the validated message to the AI assistant.
5. The response flows back through the Gateway to the channel adapter.
6. The adapter converts the response into the platform's native format and delivers it (Discord message, Telegram reply, TTS audio, HTTP JSON response).

**Configuration and lifecycle:**
- Each channel has a dedicated env file managed by the admin service (e.g., `channel-discord.env`) containing platform-specific credentials.
- The admin stores per-channel metadata (which fields are needed, help text for each field, setup guide URLs) so the UI can render a guided setup experience per channel.
- Enabling a channel involves three coordinated steps, all handled by the admin service:
  1. Write the channel's credentials to its env file.
  2. Update the Caddy reverse proxy to route traffic to the channel's endpoint, with the correct access level (private adds a LAN-only restriction rule; public removes it).
  3. Tell the admin to start the channel's container via `docker compose up -d`.
- Disabling reverses the process: stop the container and remove or restrict the route.
- Changing access level updates only the Caddy routing rule and reloads the proxy.

**Security model:**
- Each channel's container can only reach the Gateway on the internal Docker network. It cannot reach the AI assistant, memory service, admin, or admin directly.
- Every message is cryptographically signed. The Gateway rejects unsigned or incorrectly signed messages.
- The Gateway applies per-user rate limiting (120 requests/minute) before any processing occurs.
- The Gateway runs each inbound message through a restricted intake validation agent (which has no tool access) that checks for malformed input, unsafe content, and exfiltration attempts before the message reaches the main assistant.

---

## Automations

### What the user sees

Automations are recurring tasks you can schedule for your assistant. You might set up a daily morning briefing, a weekly report, or a periodic check that runs every few hours. Each automation has a name, a description of what you want the assistant to do, and a schedule (how often it runs). You can enable, disable, edit, delete, or trigger an automation manually at any time.

### What it represents

An automation is a scheduled prompt that runs against the AI assistant at a defined frequency. It combines a cron schedule with a natural-language instruction, creating a fire-and-forget job that doesn't require a user to be online or interacting with any channel.

An automation has these properties:

| Property | Description | Example |
|---|---|---|
| **ID** | Unique identifier (UUID) | `a1b2c3d4-...` |
| **Name** | User-facing label | "Daily Morning Briefing" |
| **Prompt** | The instruction sent to the assistant | "Summarize the top 5 tech headlines and post to the #news Discord channel" |
| **Schedule** | When it runs | Every day at 9:00 AM (stored as `0 9 * * *`) |
| **Status** | Whether it's active | enabled / disabled |

Automations differ from channels in a key way: channels are reactive (they respond when a user sends a message), while automations are proactive (the assistant acts on its own schedule without any user trigger).

### How it works

Automations use standard Unix cron, running inside the `admin` container. The admin service owns the full lifecycle:

**Creating or editing an automation:**
1. User provides a name, schedule (via a friendly frequency picker in the UI, which generates the cron expression), and a prompt describing what the assistant should do.
2. The admin service validates the cron expression and stores the automation metadata in a JSON data file (`crons.json`).
3. The admin generates two artifacts in admin-managed state:
   - A **JSON payload file** for the job (`cron-payloads/<id>.json`) containing the prompt, session ID, and metadata. This avoids shell-escaping issues -- cron invokes `curl -d @<file>` to read it directly.
   - A **crontab entry** that calls the assistant through the internal network (`gateway`/`admin` endpoint and local scripts under `/work`) at the scheduled time with the payload file.
4. The admin writes the complete crontab into mounted state/config paths and reloads cron state in-place (no `opencode-core` restart required).

**Execution:**
- At the scheduled time, cron fires `curl` which sends the prompt to the assistant's HTTP API as a standard chat request.
- The assistant processes it like any other message -- it can use tools, access memory, and produce a response.
- Each automation job runs in its own session (identified by `cron-<job-id>`) so conversation history doesn't bleed between jobs or with interactive sessions.

**Manual trigger:**
- The admin UI provides a "Run Now" button that sends the prompt directly to the assistant's HTTP API without waiting for the cron schedule. This is useful for testing or one-off execution.

**Disable/enable:**
- Disabling an automation comments out its crontab entry. The metadata and payload file are preserved so re-enabling is instant.

---

## Gateway

### What the user sees

The Gateway is not directly visible to users in normal operation. If it appears in the UI at all, it's as a health status indicator on the system page (described with a friendly name like "Message Router"). Users don't configure, manage, or interact with the Gateway -- it works silently behind every channel.

### What it represents

The Gateway is the central security and routing layer that sits between all channels and the AI assistant. Every message that reaches the assistant -- regardless of which channel it came from -- passes through the Gateway. It is the single enforcement point for authentication, rate limiting, input validation, and audit logging.

The Gateway exists as a distinct concept (rather than being folded into the channel or assistant descriptions) because it enforces a critical architectural invariant: **no channel can talk to the assistant directly.** This is what makes it safe to add new channels, enable public access on a channel, or install community-contributed channel adapters -- the Gateway ensures that no matter how a message arrives, it goes through the same security pipeline before the assistant sees it.

### How it works

The Gateway runs as its own container on the internal Docker network. It exposes a single inbound endpoint (`/channel/inbound`) that all channel adapters call.

**Processing pipeline for every inbound message:**

```
Channel Adapter
      |
      v
+---------------------------------------------+
| 1. SIGNATURE VERIFICATION                    |
|    Validate HMAC signature against the       |
|    channel's shared secret. Reject if        |
|    missing or invalid.                       |
+---------------------------------------------+
| 2. PAYLOAD VALIDATION                        |
|    Check that required fields (userId,       |
|    channel, text, nonce, timestamp) are      |
|    present and within bounds (text <= 10KB). |
+---------------------------------------------+
| 3. RATE LIMITING                             |
|    Per-user throttle: 120 requests per       |
|    minute. Reject with 429 if exceeded.      |
+---------------------------------------------+
| 4. INTAKE VALIDATION                         |
|    Send the message to a restricted          |
|    OpenCode agent ("channel-intake") that    |
|    has ALL tools disabled. This agent        |
|    checks for:                               |
|    - Malformed or nonsensical input          |
|    - Prompt injection / jailbreak attempts   |
|    - Data exfiltration patterns              |
|    - Unsafe or abusive content               |
|    The agent returns a structured decision:  |
|    { valid: bool, summary: string }          |
+---------------------------------------------+
| 5. FORWARD TO ASSISTANT                      |
|    If the intake agent approves, the         |
|    validated and summarized message is sent   |
|    to the main assistant for processing.     |
+---------------------------------------------+
| 6. AUDIT LOG                                 |
|    Every step is logged with timestamps,     |
|    request IDs, session IDs, user IDs,       |
|    and outcomes.                             |
+---------------------------------------------+
      |
      v
  AI Assistant
```

The intake validation agent is a notable design choice: rather than using rule-based filters, the Gateway uses a restricted [OpenCode agent](https://opencode.ai/docs/agents/) (with zero tool access) to evaluate incoming messages. This makes the validation adaptive and capable of catching sophisticated attacks that static rules would miss, while the zero-tool-access constraint means the intake agent itself cannot be exploited to perform actions.

**Key architectural properties:**
- The Gateway is the *only* service that communicates with the AI assistant on behalf of channels. Channel containers have network access only to the Gateway.
- Each channel has a unique HMAC shared secret, generated at install time and never exposed to users. Secrets are stored in the environment, not in config files.
- The Gateway is stateless -- it does not store messages, sessions, or user data. Audit logs are the only persistent artifact.
- The Gateway does not implement channel-specific logic. It receives a normalized payload and doesn't care whether it came from Discord, Telegram, voice, or chat.

---

## How the Concepts Relate

```
+-------------------------------------------------------------+
|                         User                                 |
|                                                              |
|  Manages via Admin UI:                                       |
|  +--------------+  +--------------+  +--------------+       |
|  |  Extensions  |  | Connections  |  | Automations  |       |
|  |              |  |              |  |              |       |
|  | Add abilities|  | Credentials  |  |  Scheduled   |       |
|  | to assistant |  | for services |  |    tasks     |       |
|  +------+-------+  +------+-------+  +------+-------+       |
|         |                 |                  |               |
|  Talks via:               |                  |               |
|  +--------------+         |                  |               |
|  |   Channels   |         |                  |               |
|  |              |         |                  |               |
|  | Discord, Chat|         |                  |               |
|  | Voice, Tgram |         |                  |               |
|  +------+-------+         |                  |               |
+---------+-----------------+------------------+---------------+
          |                 |                  |
          v                 v                  v
    +----------+     +----------+      +----------+
    | Gateway  |     | secrets  |      | crontab  |
    |          |     |  .env    |      |  + curl  |
    | Security |     |          |      |          |
    | routing  |     | Central  |      | Triggers |
    | audit    |     | store    |      | prompts  |
    +----+-----+     +----+-----+      +----+-----+
         |                |                  |
         v                v                  v
    +---------------------------------------------+
    |              AI Assistant                     |
    |         (opencode-core container)             |
    |                                               |
    |  +-----------+  +-----------+  +----------+  |
    |  |  Skills   |  |   Tools   |  | Plugins  |  |
    |  |  Agents   |  |  Commands |  |          |  |
    |  +-----------+  +-----------+  +----------+  |
    |       ^               ^             ^        |
    |       +------ Extensions (config dir) ---+   |
    |                                               |
    |  Uses credentials from Connections via env    |
    |  vars injected by secrets.env                 |
    +-----------------------------------------------+
```

The relationships between concepts:

- **Extensions** add capabilities to the assistant. They are managed as files and config entries in the mounted [configuration directory](https://opencode.ai/docs/config/#custom-directory).
- **Connections** provide the credentials that extensions (and the assistant itself) need to access external services. A connection is stored once and referenced by name.
- **Channels** provide the paths through which users reach the assistant. Every channel message passes through the **Gateway**, which enforces security before the assistant processes anything.
- **Automations** bypass channels entirely -- they trigger the assistant directly on a schedule, using the same internal HTTP API that the Gateway forwards to.
- The **Gateway** is the trust boundary. It doesn't appear in user workflows but it's what makes it safe to expose channels to the internet, accept community extensions, and connect to external services.

---

## OpenCode Documentation References

| Topic | URL |
|---|---|
| Configuration overview | https://opencode.ai/docs/config/ |
| Config directory (`OPENCODE_CONFIG_DIR`) | https://opencode.ai/docs/config/#custom-directory |
| Config variable interpolation (`{env:}`, `{file:}`) | https://opencode.ai/docs/config/#variables |
| Agent Skills | https://opencode.ai/docs/skills/ |
| Commands | https://opencode.ai/docs/commands/ |
| Agents | https://opencode.ai/docs/agents/ |
| Custom Tools | https://opencode.ai/docs/custom-tools/ |
| Plugins | https://opencode.ai/docs/plugins/ |
| Built-in Tools | https://opencode.ai/docs/tools/ |
| Permissions | https://opencode.ai/docs/permissions/ |
| Providers | https://opencode.ai/docs/providers/ |
| Rules / AGENTS.md | https://opencode.ai/docs/rules/ |
| Web / Server mode | https://opencode.ai/docs/web/ |
| MCP Servers | https://opencode.ai/docs/mcp-servers/ |
| Ecosystem | https://opencode.ai/docs/ecosystem/ |
## Extension management simplification

OpenPalm admin now manages only OpenCode plugins (the `plugin[]` list in user `opencode.json`).

Skills, agents, commands, and tools are still supported by OpenCode but are managed manually in `${OPENPALM_DATA_HOME}/opencode/.config/opencode/` by advanced users.
