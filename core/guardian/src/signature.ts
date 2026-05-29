/**
 * Channel secret loading and caching.
 *
 * Reads HMAC secrets from CHANNEL_<NAME>_SECRET_FILE environment variables.
 * Caches file-based secrets with TTL to avoid reading on every request.
 */

import { readFileSync, statSync } from "node:fs";
import { createLogger } from "@openpalm/channels-sdk/logger";

const logger = createLogger("guardian");

const CHANNEL_SECRET_FILE_RE = /^CHANNEL_([A-Z0-9_]+)_SECRET_FILE$/;

export class GuardianSecretFileError extends Error {
  constructor(public readonly envKey: string, reason: string) {
    super(`${envKey}: ${reason}`);
    this.name = "GuardianSecretFileError";
  }
}

function stripTrailingNewline(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

// Cache for file-based secrets to avoid reading on every request
let secretsCache: { fingerprint: string; loadedAt: number; secrets: Record<string, string> } | null = null;
const SECRETS_CACHE_TTL_MS = Math.max(5000, Number(Bun.env.GUARDIAN_SECRETS_CACHE_TTL_MS) || 30_000);

function channelFromEnvKey(envKey: string): string {
  const match = envKey.match(CHANNEL_SECRET_FILE_RE);
  return match ? match[1].toLowerCase() : "";
}

function secretFileEntries(): Array<[string, string, string]> {
  return Object.entries(Bun.env)
    .filter(([key, val]) => CHANNEL_SECRET_FILE_RE.test(key) && typeof val === "string" && val.trim())
    .map(([key, val]) => [key, channelFromEnvKey(key), val!.trim()]);
}

export function loadChannelSecrets(): Record<string, string> {
  const entries = secretFileEntries();
  if (entries.length === 0) return {};

  const stats = entries.map(([envKey, _channel, path]) => {
    try {
      const stat = statSync(path);
      return `${envKey}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      throw new GuardianSecretFileError(envKey, "secret file is unreadable");
    }
  });

  const fingerprint = stats.join("|");
  if (secretsCache
    && secretsCache.fingerprint === fingerprint
    && Date.now() - secretsCache.loadedAt < SECRETS_CACHE_TTL_MS) {
    return secretsCache.secrets;
  }

  const secrets: Record<string, string> = {};

  for (const [envKey, channel, path] of entries) {
    const secret = stripTrailingNewline(readFileSync(path, "utf8"));
    if (!secret) {
      throw new GuardianSecretFileError(envKey, "secret file is empty");
    }
    secrets[channel] = secret;
  }

  secretsCache = { fingerprint, loadedAt: Date.now(), secrets };
  logger.debug("channel_secrets_loaded", { channels: Object.keys(secrets).length });
  return secrets;
}
