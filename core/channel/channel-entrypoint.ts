function logError(msg: string): void {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    service: 'portal-entrypoint',
    msg,
  }));
}

const channelPackage = Bun.env.CHANNEL_PACKAGE;

if (!channelPackage) {
  logError('CHANNEL_PACKAGE environment variable is required');
  process.exit(1);
}

const versionAt = channelPackage.lastIndexOf('@');
const importTarget = versionAt > 0 ? channelPackage.slice(0, versionAt) : channelPackage;

let mod: Record<string, unknown>;
try {
  mod = await import(importTarget);
} catch (err) {
  logError(`Failed to import channel "${importTarget}": ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const ChannelClass = mod.default as { new (): { start?: () => void } } | undefined;
if (!ChannelClass || typeof ChannelClass !== 'function') {
  logError('Channel module must have a default export that is a class with a zero-argument constructor');
  process.exit(1);
}

let channel: { start?: () => void };
try {
  channel = new ChannelClass();
} catch (err) {
  logError(`Failed to instantiate channel: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (typeof channel.start !== 'function') {
  logError('Default export must expose a start() method');
  process.exit(1);
}

channel.start();
