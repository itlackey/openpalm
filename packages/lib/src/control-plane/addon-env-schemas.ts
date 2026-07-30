/**
 * Built-in addon env-config SCHEMAS — a LEAF module (no imports) so it can be
 * shared by both `addons.ts` (which has a heavy import graph) and the migration
 * harness without creating an import cycle (lifecycle → migrations → addons → …).
 *
 * Each schema is an env-file-shaped string: `KEY=default` lines annotated with
 * `# @required` / `# @sensitive` comment lines directly above the key.
 */
/**
 * Env keys whose write is not self-applying, and the services that must be
 * recreated for it to take effect.
 *
 * The credentials editor persists a schema key and stops there, which is right
 * for the values it was built for: a bot token or a model name is read by ONE
 * container at start, so "save, then recreate that addon" is the whole apply.
 * `OP_VOICE_LAN_ACCESS` is not that shape. Turning it on changes the compose
 * file list (voice.compose.lan.yml joins voice to `assistant_net`) AND changes
 * what the assistant's entrypoint injects into the UI co-process
 * (`OP_VOICE_URL`), so recreating only the addon leaves the assistant in the old
 * posture and LAN voice stays unavailable until some unrelated full-stack apply
 * happens to run. That is the write-decoupled-from-apply shape the access-toggle
 * work removed elsewhere on this branch, and it should not survive here.
 *
 * Declared beside the schema so a future key that needs a wider apply is one
 * entry rather than a second special case in the route.
 */
export const ADDON_ENV_RECREATE_SCOPE: Record<string, readonly string[]> = {
  OP_VOICE_LAN_ACCESS: ["voice", "assistant"],
};

export const BUILTIN_ADDON_ENV_SCHEMAS: Record<string, string> = {
  api: `# API Gateway portal configuration
# ---
`,
  chat: `# Web Chat portal configuration
# ---
`,
  discord: `# Discord bot configuration
# ---

# Discord credentials
# ---

# Application ID from the Discord Developer Portal.
# https://discord.com/developers/applications
# @required
DISCORD_APPLICATION_ID=

# Bot token from the Discord Developer Portal (Bot → Token).
# @required @sensitive
DISCORD_BOT_TOKEN=

# ---
# Access control
# ---

# Comma-separated allowed guild (server) IDs. Empty = all joined guilds.
DISCORD_ALLOWED_GUILDS=

# Comma-separated allowed role IDs.
DISCORD_ALLOWED_ROLES=

# Comma-separated allowed user IDs.
DISCORD_ALLOWED_USERS=

# Comma-separated blocked user IDs (denied even if otherwise allowed).
DISCORD_BLOCKED_USERS=

# ---
# Behavior
# ---

# Register slash commands on startup.
DISCORD_REGISTER_COMMANDS=true

# Hours before a conversation thread expires.
DISCORD_THREAD_TTL_HOURS=24

# Milliseconds to wait before forwarding a message (0 = immediate).
DISCORD_FORWARD_TIMEOUT_MS=0
`,
  slack: `# Slack bot configuration
# ---

# Slack credentials
# ---

# Bot User OAuth Token (OAuth & Permissions → Bot User OAuth Token).
# @required @sensitive
SLACK_BOT_TOKEN=

# App-Level Token with connections:write (Basic Information → App-Level Tokens).
# @required @sensitive
SLACK_APP_TOKEN=

# ---
# Access control
# ---

# Comma-separated allowed channel IDs. Empty = all channels the bot is in.
SLACK_ALLOWED_CHANNELS=

# Comma-separated allowed user IDs.
SLACK_ALLOWED_USERS=

# Comma-separated blocked user IDs.
SLACK_BLOCKED_USERS=

# ---
# Appearance
# ---

# Display name used in Slack modal titles and the App Home tab.
# Default: OpenPalm
SLACK_BOT_NAME=

`,
  gateway: '',
  ollama: '',
  voice: `# OpenPalm Voice (Kokoro TTS + Whisper STT) configuration
# ---
# Local inference server — no upstream API or key. Values are optional; the
# compose overlay supplies safe defaults.

# faster-whisper model id. Default base.en is baked into the image.
# @required
OP_VOICE_WHISPER_MODEL=base.en

# Default Kokoro voice id (54 bundled voices, e.g. af_heart, am_michael).
OP_VOICE_KOKORO_VOICE=bf_isabella

# Python logging level: debug, info, warning, error.
OP_VOICE_LOG_LEVEL=info

# Let devices on your network use voice through the published UI. Off by
# default: enabling it puts the voice container on the assistant's Docker
# network so the published UI can reach it.
# @boolean
OP_VOICE_LAN_ACCESS=false
`,
};

