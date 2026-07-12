/**
 * Built-in addon env-config SCHEMAS — a LEAF module (no imports) so it can be
 * shared by both `addons.ts` (which has a heavy import graph) and the migration
 * harness without creating an import cycle (lifecycle → migrations → addons → …).
 *
 * Each schema is an env-file-shaped string: `KEY=default` lines annotated with
 * `# @required` / `# @sensitive` comment lines directly above the key.
 */
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
`,
};

/**
 * The set of NON-sensitive addon env keys declared in BUILTIN_ADDON_ENV_SCHEMAS
 * — a `KEY=` line whose annotation comment block does NOT carry `@sensitive`.
 *
 * This is the ALLOWLIST for the C4 `knowledge/secrets/` → `stack.env` migration:
 * it must only ever promote real, declared, non-sensitive addon config. The
 * secrets dir is a GENERAL secret store (ssh keys, github/OAuth creds, akm
 * secrets, per-portal verification secrets) — a file must never be copied into
 * the non-secret stack.env just because its name lacks a `_TOKEN/_SECRET/...`
 * suffix.
 */
export function nonSensitiveAddonEnvKeys(): Set<string> {
  const keys = new Set<string>();
  const KEY_RE = /^([A-Z][A-Z0-9_]*)=/;
  for (const schema of Object.values(BUILTIN_ADDON_ENV_SCHEMAS)) {
    let sensitive = false;
    for (const raw of schema.split('\n')) {
      const trimmed = raw.trim();
      if (trimmed.startsWith('#')) { if (/@sensitive\b/.test(trimmed)) sensitive = true; continue; }
      const m = raw.match(KEY_RE);
      if (m) { if (!sensitive) keys.add(m[1]); sensitive = false; continue; }
      if (trimmed === '') sensitive = false;
    }
  }
  return keys;
}
