import { BaseChannel, createLogger, type HandleResult } from "@openpalm/channels-sdk";
import { buildCommandRegistry, parseCustomCommands } from "./commands.ts";
import { registerCommands, type DiscordApiConfig } from "./discord-api.ts";
import { handleInteraction, type InteractionDeps } from "./interactions.ts";
import { loadPermissionConfig } from "./permissions.ts";
import type { CustomCommandDef, DiscordInteraction, PermissionConfig } from "./types.ts";

const log = createLogger("channel-discord");

type DiscordWebhookBody = Record<string, unknown>;

async function verifyDiscordSignature(
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

export default class DiscordChannel extends BaseChannel {
  name = "discord";

  private permissions: PermissionConfig = loadPermissionConfig();
  private commands: CustomCommandDef[] = buildCommandRegistry(parseCustomCommands(Bun.env.DISCORD_CUSTOM_COMMANDS)).all;

  get publicKey(): string {
    return Bun.env.DISCORD_PUBLIC_KEY ?? "";
  }

  get applicationId(): string {
    return Bun.env.DISCORD_APPLICATION_ID ?? "";
  }

  get botToken(): string {
    return Bun.env.DISCORD_BOT_TOKEN ?? "";
  }

  async route(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/discord/interactions" && req.method === "POST") {
      const contentLength = Number(req.headers.get("content-length") ?? "0");
      if (contentLength > 1_048_576) {
        return this.json(413, { error: "payload_too_large" });
      }

      let rawBody: string;
      try {
        rawBody = await req.text();
      } catch {
        return this.json(400, { error: "read_error" });
      }

      if (this.publicKey) {
        const sig = req.headers.get("x-signature-ed25519") ?? "";
        const ts = req.headers.get("x-signature-timestamp") ?? "";
        const valid = await verifyDiscordSignature(this.publicKey, sig, ts, rawBody);
        if (!valid) {
          return this.json(401, { error: "invalid_signature" });
        }
      }

      let interaction: DiscordInteraction;
      try {
        interaction = JSON.parse(rawBody) as DiscordInteraction;
      } catch {
        return this.json(400, { error: "invalid_json" });
      }

      const deps: InteractionDeps = {
        guardianUrl: this.guardianUrl,
        sharedSecret: this.secret,
        applicationId: this.applicationId,
        commands: this.commands,
        permissions: this.permissions,
        forwardFetch: fetch,
      };

      const response = await handleInteraction(interaction, deps);
      return this.json(200, response);
    }

    if (url.pathname === "/discord/webhook") {
      if (req.method === "POST") return null;
      return this.json(404, { error: "not_found" });
    }

    if (url.pathname === "/health") return null;
    return this.json(404, { error: "not_found" });
  }

  async handleRequest(req: Request): Promise<HandleResult | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/discord/webhook") return null;

    let body: DiscordWebhookBody;
    try {
      body = await req.json() as DiscordWebhookBody;
    } catch {
      throw new Error("invalid_json");
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return { userId: "", text: "" };

    const rawUserId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!rawUserId) return { userId: "", text };

    return {
      userId: `discord:${rawUserId}`,
      text,
      metadata: {
        channelId: body.channelId,
        guildId: body.guildId,
        username: body.username,
      },
    };
  }

  private registerCommandsOnStart(): void {
    const registrationPayload = buildCommandRegistry(parseCustomCommands(Bun.env.DISCORD_CUSTOM_COMMANDS)).registrationPayload;
    if (!this.applicationId || !this.botToken || Bun.env.DISCORD_REGISTER_COMMANDS === "false") {
      if (!this.applicationId) {
        log.warn("startup_warning", { reason: "DISCORD_APPLICATION_ID not set — slash command registration skipped" });
      }
      return;
    }

    const apiConfig: DiscordApiConfig = {
      applicationId: this.applicationId,
      botToken: this.botToken,
    };

    const allowedGuilds = this.permissions.allowedGuilds;
    if (allowedGuilds.size > 0) {
      for (const guildId of allowedGuilds) {
        void registerCommands(apiConfig, registrationPayload, guildId);
      }
      return;
    }

    void registerCommands(apiConfig, registrationPayload);
  }

  override start(): void {
    if (!this.publicKey) {
      log.warn("startup_warning", { reason: "DISCORD_PUBLIC_KEY is not set — signature verification disabled" });
    }
    this.registerCommandsOnStart();
    super.start();
  }
}

export { verifyDiscordSignature };
