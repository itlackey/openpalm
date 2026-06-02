/**
 * OpenPalm Channel Entrypoint — Dynamic loader for community channel adapters.
 *
 * This script is the CMD of the unified channel Docker image.
 * It loads a channel from either an npm package or a local TypeScript file,
 * validates it exports a BaseChannel subclass, and starts the server.
 *
 * Environment:
 *   CHANNEL_PACKAGE — npm package name (required, e.g., "@openpalm/channel-discord")
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

if (!channelPackage) {
  logError("CHANNEL_PACKAGE environment variable is required");
  process.exit(1);
}

// CHANNEL_PACKAGE may carry an install spec with a version pin
// (e.g. "@openpalm/channel-discord@0.11.0-beta.13" — start.sh installs it with
// `bun add --exact`). The module specifier for import() is the bare package
// NAME without the version. Strip a trailing "@<version>" while preserving the
// leading "@scope" of scoped packages.
const versionAt = channelPackage.lastIndexOf("@");
const importTarget = versionAt > 0 ? channelPackage.slice(0, versionAt) : channelPackage;

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
