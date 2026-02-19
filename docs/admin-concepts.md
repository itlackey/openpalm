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

The admin UI and API never expose these type distinctions as primary navigation. Instead, each extension in the gallery has a risk badge and a plain-language description of what permissions it needs. The type is available as metadata for users who want it, but it's not required to make decisions.

### How it works

Extensions are managed through the OpenCode [configuration directory](https://opencode.ai/docs/config/#custom-directory), which is a volume mounted into the `opencode-core` container. OpenCode supports a custom config directory via the `OPENCODE_CONFIG_DIR` environment variable -- this directory is searched for `agents/`, `commands/`, `modes/`, `plugins/`, `skills/`, `tools/`, and `themes/` subdirectories just like the standard `.opencode` directory, and follows the same structure. The custom directory is loaded after the global config and `.opencode` directories, so it can override their settings.

Configuration files across all sources are [merged together](https://opencode.ai/docs/config/#precedence-order), not replaced. The full precedence order is:

1. Remote config (from `.well-known/opencode`) -- organizational defaults
2. Global config (`~/.config/opencode/opencode.json`) -- user preferences
3. Custom config (`OPENCODE_CONFIG` env var) -- custom overrides
4. Project config (`opencode.json` in project) -- project-specific settings
5. `.opencode` directories -- agents, commands, plugins
6. Inline config (`OPENCODE_CONFIG_CONTENT` env var) -- runtime overrides

The install/enable lifecycle works as follows:

1. **Gallery or registry provides extension metadata** -- name, description, risk level, extension type, and the install target (a file path for bundled extensions, or an npm package identifier for plugins).

2. **Admin service resolves the install action based on type:**
   - *Skills, commands, agents, custom tools:* The extension files ship with the OpenPalm image (baked into the `opencode-core` container at build time). "Installing" means placing them into the mounted configuration directory so OpenCode picks them up. Some may already be present via the entrypoint's `cp -rn` merge from the baked-in defaults.
   - *Plugins (local):* A local `.ts` file is placed in the `plugins/` subdirectory of the mounted config directory. Local plugins are loaded directly from this directory at startup.
   - *Plugins (npm):* The npm package name (e.g., `"opencode-helicone-session"` or `"@my-org/custom-plugin"`) is added to the `plugin` array in `opencode.jsonc`. npm plugins are [installed automatically by Bun](https://opencode.ai/docs/plugins/#how-plugins-are-installed) at startup and cached in `~/.cache/opencode/node_modules/`.
   - *Plugin load order:* Global config plugins -> project config plugins -> global plugin directory -> project/custom plugin directory. Duplicate npm packages with the same name and version are loaded once.

3. **Admin tells the controller to restart `opencode-core`** -- the next session picks up the changed configuration directory and/or the updated `opencode.jsonc`.

4. **Uninstall reverses the process** -- remove the file from the config directory or remove the entry from `opencode.jsonc`, then restart.

The configuration directory mount is the key architectural element. It means the admin service never needs to exec into the opencode-core container or modify its image. It only writes files to a shared volume and edits a JSON config file.

**Extension discovery** happens through three sources:

- A **curated gallery** of reviewed extensions with risk assessments, bundled with the admin service image. These are known-good and pre-audited.
- A **community registry** fetched at runtime from a public JSON index hosted on GitHub. The admin caches this and lets users browse community-contributed extensions alongside curated ones.
- An **npm search** fallback for discovering OpenCode plugins that aren't in either registry. These are marked as unreviewed and high-risk.

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

## Connections

> **Implementation Status:** The Connections concept is partially implemented. Credentials are currently managed per-feature (AI provider keys in `secrets.env`, channel tokens in channel `.env` files, and provider settings via the admin UI's System > Providers section). The unified Connections management UI described below is planned for a future release.

### What the user sees

Connections are where you manage the accounts and credentials your assistant uses to interact with external services. If you want your assistant to use a specific AI model provider, connect to your GitHub account, or access an API, you set that up as a connection. Each connection has a friendly name (like "Anthropic" or "GitHub"), shows whether it's configured, and lets you enter or update credentials. Once a connection is set up, it becomes available wherever it's needed -- you might use the same OpenAI connection for both the assistant's memory system and an extension that needs embeddings.

### What it represents

A connection is a named set of credentials and endpoint configuration for an external service. Connections are the single source of truth for authentication details used across the stack. Rather than scattering API keys and URLs across multiple `.env` files and config blocks, each credential is stored once in a central secret store and referenced by name wherever it's needed.

A connection has these properties:

| Property | Description | Example |
|---|---|---|
| **ID** | Stable internal identifier | `anthropic`, `github`, `openai-embeddings` |
| **Name** | User-facing display name | "Anthropic", "GitHub", "OpenAI (Embeddings)" |
| **Type** | Connection category | `ai-provider`, `platform`, `api-service` |
| **Endpoint** | Base URL for the service (if configurable) | `https://api.anthropic.com` |
| **Credentials** | One or more secret values (API keys, tokens) | API key, OAuth token, username/password |
| **Status** | Whether the connection is configured and valid | configured / not configured / error |
| **Used by** | Which parts of the stack reference this connection | "AI Assistant (primary model)", "Memory system" |

Connection types serve as organizational categories in the UI:

- **AI Provider** -- LLM API endpoints used by the assistant or memory system (Anthropic, OpenAI, local Ollama instances). OpenCode supports [many providers](https://opencode.ai/docs/providers/) natively including OpenAI, Anthropic, Google Gemini, AWS Bedrock, Groq, Azure OpenAI, OpenRouter, and self-hosted endpoints via `LOCAL_ENDPOINT`.
- **Platform** -- Developer platforms the assistant can interact with (GitHub, GitLab)
- **API Service** -- External services used by extensions or channels (search APIs, notification services)

### How it works

Connections are stored in a central secrets file (`secrets.env`) that is mounted as a volume accessible to services that need credentials. The admin service manages this file through a structured API -- users never see or edit the env file directly.

The lifecycle:

1. **User creates or edits a connection** through the admin UI by filling in labeled fields (endpoint URL, API key, etc.).

2. **Admin service writes the credentials** to `secrets.env` using standardized key naming:
   ```
   OPENPALM_CONN_ANTHROPIC_API_KEY=sk-ant-...
   OPENPALM_CONN_ANTHROPIC_ENDPOINT=https://api.anthropic.com
   OPENPALM_CONN_GITHUB_TOKEN=ghp_...
   OPENPALM_CONN_OPENAI_API_KEY=sk-...
   OPENPALM_CONN_OPENAI_ENDPOINT=https://api.openai.com/v1
   ```

   > **Note (current vs. planned):** The `OPENPALM_CONN_*` prefix is the **planned standardization** for a future admin-managed secrets layer. In the current implementation, secrets use the standard provider names that the underlying tools expect directly (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). OpenCode's env var interpolation in `opencode.jsonc` therefore references these unprefixed names (e.g., `"{env:ANTHROPIC_API_KEY}"`). The `OPENPALM_CONN_*` convention will be adopted once the admin service's credential management layer is implemented.

3. **Admin maintains a connection registry** (a JSON metadata file) that tracks which connections exist, their types, display names, and which stack components reference them. This registry is what the UI reads to render the connections list with status indicators.

4. **Other parts of the stack reference connections by name.** When configuring which AI provider the memory system uses, the admin writes the resolved endpoint and API key env vars to the appropriate service configuration (e.g., `OPENAI_BASE_URL` and `OPENAI_API_KEY` for the memory service). The connection registry records this binding so the UI can show "Used by: Memory system."

5. **OpenCode provider configuration** is updated in `opencode.jsonc` to reference the credentials via [env var interpolation](https://opencode.ai/docs/config/#env-vars) (e.g., `"apiKey": "{env:OPENPALM_CONN_ANTHROPIC_API_KEY}"`). This means the actual secret never appears in the config file. OpenCode's config supports `{env:VAR_NAME}` syntax for referencing environment variables and `{file:./path}` syntax for referencing file contents.

The key design principle: credentials are written to exactly one file and referenced everywhere else by environment variable name. The admin UI provides the abstraction layer that lets users think in terms of "my Anthropic account" rather than "which env var holds my API key."

**Connection validation** -- when a user saves a connection, the admin can optionally probe the endpoint (e.g., a lightweight API call) to verify the credentials are valid before committing them. Invalid connections are shown with a warning status rather than blocking the save.

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
  3. Tell the controller to start the channel's container via `docker compose up -d`.
- Disabling reverses the process: stop the container and remove or restrict the route.
- Changing access level updates only the Caddy routing rule and reloads the proxy.

**Security model:**
- Each channel's container can only reach the Gateway on the internal Docker network. It cannot reach the AI assistant, memory service, admin, or controller directly.
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

Automations use standard Unix cron, running inside the `opencode-core` container. The admin service manages the full lifecycle:

**Creating or editing an automation:**
1. User provides a name, schedule (via a friendly frequency picker in the UI, which generates the cron expression), and a prompt describing what the assistant should do.
2. The admin service validates the cron expression and stores the automation metadata in a JSON data file (`crons.json`).
3. The admin generates two artifacts:
   - A **JSON payload file** for the job (`cron-payloads/<id>.json`) containing the prompt, session ID, and metadata. This avoids shell-escaping issues -- cron invokes `curl -d @<file>` to read it directly.
   - A **crontab entry** that calls `curl` against the assistant's local HTTP endpoint (`http://localhost:4096/chat`) at the scheduled time with the payload file. OpenCode's [web/server mode](https://opencode.ai/docs/web/) exposes this HTTP API.
4. The admin writes the complete crontab to a shared config volume and tells the controller to restart `opencode-core`, which installs the updated crontab on startup via its entrypoint script.

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