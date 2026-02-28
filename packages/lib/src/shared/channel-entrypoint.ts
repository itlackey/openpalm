/**
 * OpenPalm Channel Entrypoint — Dynamic loader for community channel adapters.
 *
 * This script is the CMD of the prebuilt channel-base Docker image.
 * It loads a user-provided TypeScript file, validates it exports a BaseChannel
 * subclass, and starts the server.
 *
 * Environment:
 *   CHANNEL_FILE — path to the channel .ts file (default: /app/channel.ts)
 */

import { BaseChannel } from "./channel-base.ts";

const channelFile = Bun.env.CHANNEL_FILE ?? "/app/channel.ts";

// Validate file exists
const file = Bun.file(channelFile);
if (!(await file.exists())) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    service: "channel-entrypoint",
    msg: `Channel file not found: ${channelFile}`,
  }));
  process.exit(1);
}

// Dynamic import
let mod: Record<string, unknown>;
try {
  mod = await import(channelFile);
} catch (err) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    service: "channel-entrypoint",
    msg: `Failed to import channel file: ${err instanceof Error ? err.message : String(err)}`,
  }));
  process.exit(1);
}

// Resolve default export
const ChannelClass = mod.default as { new (): BaseChannel } | undefined;
if (!ChannelClass || typeof ChannelClass !== "function") {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    service: "channel-entrypoint",
    msg: "Channel file must have a default export that is a class with a zero-argument constructor",
  }));
  process.exit(1);
}

// Instantiate and validate
let channel: BaseChannel;
try {
  channel = new ChannelClass();
} catch (err) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    service: "channel-entrypoint",
    msg: `Failed to instantiate channel: ${err instanceof Error ? err.message : String(err)}`,
  }));
  process.exit(1);
}

if (!(channel instanceof BaseChannel)) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    service: "channel-entrypoint",
    msg: "Default export must extend BaseChannel from @openpalm/lib/shared/channel-base.ts",
  }));
  process.exit(1);
}

// Start
channel.start();
