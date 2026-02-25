/**
 * Discord channel server for OpenPalm.
 *
 * Handles Discord interactions (slash commands, buttons, autocomplete) and a
 * REST webhook endpoint. Supports guild/role/user permission constraints,
 * custom slash commands, deferred responses, and structured logging.
 *
 * Endpoints:
 *   GET  /health                → Health status
 *   POST /discord/interactions  → Discord Interactions Endpoint (slash commands, components)
 *   POST /discord/webhook       → REST webhook for external integrations
 */

import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import type { DiscordInteraction, PermissionConfig, CustomCommandDef } from "./types.ts";
import { handleInteraction, type InteractionDeps } from "./interactions.ts";
import { loadPermissionConfig } from "./permissions.ts";
import { parseCustomCommands, buildCommandRegistry } from "./commands.ts";
import { registerCommands, type DiscordApiConfig } from "./discord-api.ts";
import { log, setLogLevel, type LogLevel } from "./logger.ts";

/* ── Discord signature verification ────────────────────────────────── */

export async function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  if (!publicKey || !signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(publicKey, "hex"),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      Buffer.from(signature, "hex"),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

/* ── Webhook handler (unchanged protocol, adds permission awareness) ─ */

async function handleWebhook(
  req: Request,
  gatewayUrl: string,
  sharedSecret: string,
  forwardFetch: typeof fetch,
): Promise<Response> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > 1_048_576) {
    return json(413, { error: "payload_too_large" });
  }

  let body: {
    userId?: string;
    text?: string;
    channelId?: string;
    guildId?: string;
    username?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!body.text) return json(400, { error: "text_required" });

  const userId = body.userId ? `discord:${body.userId}` : "";
  if (!userId) return json(400, { error: "missing_user_id" });

  const payload = buildChannelMessage({
    userId,
    channel: "discord",
    text: body.text,
    metadata: {
      channelId: body.channelId,
      guildId: body.guildId,
      username: body.username,
    },
  });

  const resp = await forwardChannelMessage(gatewayUrl, sharedSecret, payload, forwardFetch);

  if (!resp.ok) {
    return json(resp.status >= 500 ? 502 : resp.status, {
      error: "gateway_error",
      status: resp.status,
    });
  }

  return json(resp.status, await resp.json());
}

/* ── Server config ─────────────────────────────────────────────────── */

export type DiscordServerConfig = {
  gatewayUrl: string;
  sharedSecret: string;
  publicKey: string;
  applicationId: string;
  commands: CustomCommandDef[];
  permissions: PermissionConfig;
  forwardFetch?: typeof fetch;
};

/* ── Main fetch handler factory ────────────────────────────────────── */

export function createDiscordFetch(config: DiscordServerConfig) {
  const {
    gatewayUrl,
    sharedSecret,
    publicKey,
    applicationId,
    commands,
    permissions,
    forwardFetch = fetch,
  } = config;

  const interactionDeps: InteractionDeps = {
    gatewayUrl,
    sharedSecret,
    applicationId,
    commands,
    permissions,
    forwardFetch,
  };

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    /* ── Health ──────────────────────────────────────────────────── */
    if (url.pathname === "/health") {
      return json(200, {
        ok: true,
        service: "channel-discord",
        commands: commands.map((c) => c.name),
        permissions: {
          guilds: permissions.allowedGuilds.size || "unrestricted",
          roles: permissions.allowedRoles.size || "unrestricted",
          users: permissions.allowedUsers.size || "unrestricted",
          blocked: permissions.blockedUsers.size,
        },
      });
    }

    /* ── Discord Interactions Endpoint ───────────────────────────── */
    if (url.pathname === "/discord/interactions" && req.method === "POST") {
      const contentLength = Number(req.headers.get("content-length") ?? "0");
      if (contentLength > 1_048_576) {
        return json(413, { error: "payload_too_large" });
      }

      let rawBody: string;
      try {
        rawBody = await req.text();
      } catch {
        return json(400, { error: "read_error" });
      }

      // Verify Discord Ed25519 signature (skip if no public key configured — dev mode)
      if (publicKey) {
        const sig = req.headers.get("x-signature-ed25519") ?? "";
        const ts = req.headers.get("x-signature-timestamp") ?? "";
        const valid = await verifyDiscordSignature(publicKey, sig, ts, rawBody);
        if (!valid) {
          log.warn("invalid_signature", { path: url.pathname });
          return json(401, { error: "invalid_signature" });
        }
      }

      let interaction: DiscordInteraction;
      try {
        interaction = JSON.parse(rawBody) as DiscordInteraction;
      } catch {
        return json(400, { error: "invalid_json" });
      }

      const response = await handleInteraction(interaction, interactionDeps);
      return json(200, response);
    }

    /* ── REST webhook (backward-compatible) ──────────────────────── */
    if (url.pathname === "/discord/webhook" && req.method === "POST") {
      return handleWebhook(req, gatewayUrl, sharedSecret, forwardFetch);
    }

    return json(404, { error: "not_found" });
  };
}

/* ── Startup ───────────────────────────────────────────────────────── */

if (import.meta.main) {
  const PORT = Number(Bun.env.PORT ?? 8184);
  const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
  const SHARED_SECRET = Bun.env.CHANNEL_DISCORD_SECRET ?? "";
  const DISCORD_PUBLIC_KEY = Bun.env.DISCORD_PUBLIC_KEY ?? "";
  const DISCORD_APPLICATION_ID = Bun.env.DISCORD_APPLICATION_ID ?? "";
  const DISCORD_BOT_TOKEN = Bun.env.DISCORD_BOT_TOKEN ?? "";
  const LOG_LEVEL = (Bun.env.DISCORD_LOG_LEVEL ?? "info") as LogLevel;

  setLogLevel(LOG_LEVEL);

  // Validate required config
  if (!SHARED_SECRET) {
    log.error("startup_fatal", { reason: "CHANNEL_DISCORD_SECRET is not set" });
    process.exit(1);
  }

  if (!DISCORD_PUBLIC_KEY) {
    log.warn("startup_warning", { reason: "DISCORD_PUBLIC_KEY is not set — signature verification disabled" });
  }

  // Load permissions
  const permissions = loadPermissionConfig();

  // Load commands (built-in + custom)
  const customCommands = parseCustomCommands(Bun.env.DISCORD_CUSTOM_COMMANDS);
  const { all: allCommands, registrationPayload } = buildCommandRegistry(customCommands);

  // Register slash commands with Discord if configured
  if (DISCORD_APPLICATION_ID && DISCORD_BOT_TOKEN && Bun.env.DISCORD_REGISTER_COMMANDS !== "false") {
    const apiConfig: DiscordApiConfig = {
      applicationId: DISCORD_APPLICATION_ID,
      botToken: DISCORD_BOT_TOKEN,
    };

    // Register to specific guilds if allowlist is set, otherwise globally
    const allowedGuilds = permissions.allowedGuilds;
    if (allowedGuilds.size > 0) {
      for (const guildId of allowedGuilds) {
        registerCommands(apiConfig, registrationPayload, guildId);
      }
    } else {
      registerCommands(apiConfig, registrationPayload);
    }
  } else if (!DISCORD_APPLICATION_ID) {
    log.warn("startup_warning", { reason: "DISCORD_APPLICATION_ID not set — slash command registration skipped" });
  }

  // Start the server
  const serverConfig: DiscordServerConfig = {
    gatewayUrl: GATEWAY_URL,
    sharedSecret: SHARED_SECRET,
    publicKey: DISCORD_PUBLIC_KEY,
    applicationId: DISCORD_APPLICATION_ID,
    commands: allCommands,
    permissions,
  };

  Bun.serve({ port: PORT, fetch: createDiscordFetch(serverConfig) });

  log.info("startup", {
    port: PORT,
    commands: allCommands.map((c) => c.name),
    signatureVerification: !!DISCORD_PUBLIC_KEY,
    commandRegistration: !!(DISCORD_APPLICATION_ID && DISCORD_BOT_TOKEN),
  });
}
