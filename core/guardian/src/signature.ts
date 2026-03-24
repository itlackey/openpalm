/**
 * Channel secret loading and caching.
 *
 * Reads HMAC secrets from a secrets file (GUARDIAN_SECRETS_PATH) or
 * falls back to process environment variables. Caches file-based
 * secrets with TTL to avoid reading on every request.
 */

import { parse as dotenvParse } from "dotenv";
import { createLogger } from "@openpalm/channels-sdk/logger";

const logger = createLogger("guardian");

const CHANNEL_SECRET_RE = /^CHANNEL_[A-Z0-9_]+_SECRET$/;

export function parseChannelSecrets(content: string): Record<string, string> {
  const parsed = dotenvParse(content);
  const secrets: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (CHANNEL_SECRET_RE.test(key) && typeof val === "string" && val) {
      const ch = key.replace(/^CHANNEL_/, "").replace(/_SECRET$/, "").toLowerCase();
      secrets[ch] = val;
    }
  }
  return secrets;
}

// Cache for file-based secrets to avoid reading on every request
let secretsCache: { mtime: number; loadedAt: number; secrets: Record<string, string> } | null = null;
const SECRETS_CACHE_TTL_MS = Math.max(5000, Number(Bun.env.GUARDIAN_SECRETS_CACHE_TTL_MS) || 30_000);

const SECRETS_PATH = Bun.env.GUARDIAN_SECRETS_PATH;

export async function loadChannelSecrets(): Promise<Record<string, string>> {
  if (SECRETS_PATH) {
    try {
      const file = Bun.file(SECRETS_PATH);
      const mtime = file.lastModified;
      if (secretsCache
        && secretsCache.mtime === mtime
        && Date.now() - secretsCache.loadedAt < SECRETS_CACHE_TTL_MS) {
        return secretsCache.secrets;
      }
      const content = await file.text();
      const secrets = parseChannelSecrets(content);
      secretsCache = { mtime, loadedAt: Date.now(), secrets };
      return secrets;
    } catch {
      logger.warn("secrets_file_unreadable", { path: SECRETS_PATH });
      return {};
    }
  }
  // Fallback: read from process env (dev/test without GUARDIAN_SECRETS_PATH)
  const secrets: Record<string, string> = {};
  for (const [key, val] of Object.entries(Bun.env)) {
    if (CHANNEL_SECRET_RE.test(key) && val) {
      const ch = key.replace(/^CHANNEL_/, "").replace(/_SECRET$/, "").toLowerCase();
      secrets[ch] = val;
    }
  }
  return secrets;
}
