/**
 * OpenPalm Channel Entrypoint — Dynamic loader for community channel adapters.
 *
 * This script is the CMD of the unified channel-runner Docker image.
 * It loads a channel from either an npm package or a local TypeScript file,
 * validates it exports a BaseChannel subclass, and starts the server.
 *
 * Environment:
 *   CHANNEL_PACKAGE — npm package name (e.g., "@openpalm/channel-discord")
 *   CHANNEL_FILE    — path to the channel .ts file (default: /app/channel.ts)
 *
 * Resolution order:
 *   1. If CHANNEL_PACKAGE is set, import the npm package
 *   2. Else if CHANNEL_FILE exists, import the local file
 *   3. Else exit with error
 */

import { BaseChannel } from "./channel-base.ts";

function logError(msg: string): void {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    service: "channel-entrypoint",
    msg,
  }));
}

const channelPackage = Bun.env.CHANNEL_PACKAGE;
const channelFile = Bun.env.CHANNEL_FILE ?? "/app/channel.ts";

let importTarget: string;

if (channelPackage) {
  importTarget = channelPackage;
} else {
  // Legacy file-based loading
  const file = Bun.file(channelFile);
  if (!(await file.exists())) {
    logError(`No CHANNEL_PACKAGE set and channel file not found: ${channelFile}`);
    process.exit(1);
  }
  importTarget = channelFile;
}

// Dynamic import
let mod: Record<string, unknown>;
try {
  mod = await import(importTarget);
} catch (err) {
  logError(`Failed to import channel "${importTarget}": ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Resolve default export
const ChannelClass = mod.default as { new (): BaseChannel } | undefined;
if (!ChannelClass || typeof ChannelClass !== "function") {
  logError("Channel module must have a default export that is a class with a zero-argument constructor");
  process.exit(1);
}

// Instantiate and validate
let channel: BaseChannel;
try {
  channel = new ChannelClass();
} catch (err) {
  logError(`Failed to instantiate channel: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!(channel instanceof BaseChannel)) {
  logError("Default export must extend BaseChannel from @openpalm/channels-sdk");
  process.exit(1);
}

// Start
channel.start();
