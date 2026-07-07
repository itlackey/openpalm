/**
 * Shared env-derived configuration for the guardian.
 *
 * Several guardian modules independently re-read the same environment variables
 * with the same inline defaults. Centralising them here gives a single source of
 * truth and removes config-drift risk (e.g. an assistant-URL default that only
 * gets updated in some modules).
 *
 * Read timing is deliberately preserved to match the original call sites:
 *   - Values that every consumer read at MODULE LOAD (via a top-level `const`)
 *     are exported here as constants, so they resolve exactly once at startup —
 *     identical to before. The guardian is always spawned with its env fully set
 *     (see the subprocess harnesses in *.test.ts), so a load-time read is safe.
 *   - `GUARDIAN_URL` was read DYNAMICALLY in `openai-api.ts` (a per-instance class
 *     field) and at load time in `openai-api-oc-client.ts`. A lazy getter honours
 *     BOTH: each call site still reads the env at its original moment.
 *
 * The exact env var names and default values are unchanged.
 */

/** Upstream OpenCode assistant base URL. Read once at module load. */
export const ASSISTANT_URL = Bun.env.OP_ASSISTANT_URL ?? "http://assistant:4096";

/** Session-cache / ownership TTL, in ms (15 min default). Read once at module load. */
export const SESSION_TTL_MS = Number(Bun.env.GUARDIAN_SESSION_TTL_MS ?? 15 * 60_000);

/** Guardian direct-ingress port. Read once at module load. */
export const DIRECT_PORT = Number(Bun.env.GUARDIAN_DIRECT_PORT ?? 3830);

function normalizeExactOrigin(value: string): string {
  if (value === '*') throw new Error('GUARDIAN_CORS_ALLOWED_ORIGINS must not contain wildcard origins');
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`GUARDIAN_CORS_ALLOWED_ORIGINS entry must use http or https: ${value}`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`GUARDIAN_CORS_ALLOWED_ORIGINS entry must be an exact origin with no path/query/hash: ${value}`);
  }
  return url.origin;
}

function parseAllowedOrigins(value: string): ReadonlySet<string> {
  const origins = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeExactOrigin);
  return new Set(origins);
}

/** Exact browser origins allowed to receive CORS headers on direct ingress. */
export const CORS_ALLOWED_ORIGINS = parseAllowedOrigins(Bun.env.GUARDIAN_CORS_ALLOWED_ORIGINS ?? '');

export function resolveCorsAllowedOrigin(origin: string | null): string | null {
  if (!origin || origin === 'null') return null;
  let normalized: string;
  try {
    normalized = normalizeExactOrigin(origin);
  } catch {
    return null;
  }
  return CORS_ALLOWED_ORIGINS.has(normalized) ? normalized : null;
}

/**
 * Guardian's own base URL as seen by API clients. Read lazily to preserve the
 * per-instance read semantics of `GuardianOpenAiApi.guardianUrl`.
 */
export function resolveGuardianUrl(): string {
  return Bun.env.GUARDIAN_URL ?? "http://guardian:8080";
}
