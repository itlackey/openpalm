import { readFileSync } from "node:fs";

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

/**
 * Clamp a raw env string to a positive integer, falling back on ANY malformed
 * value. `Number(garbage)` is NaN, and NaN flowing onward fails far from the
 * cause: a NaN port makes Bun.serve blow up at boot, and a NaN SQLite binding
 * is NULL — which once turned a bounded ownership-table DELETE unbounded (see
 * state-db.ts). Floor FIRST: a fractional value in (0, 1) would pass a
 * positivity check and then floor to 0 at the use site.
 * Pure half of {@link readPositiveIntEnv}, exported for reuse and tests.
 */
export function clampPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Read a positive-integer env override via {@link clampPositiveInt} — the
 *  one way guardian code reads numeric env (ports, limits, timeouts). */
export function readPositiveIntEnv(name: string, fallback: number): number {
  return clampPositiveInt(Bun.env[name], fallback);
}

/** Guardian direct-ingress port. Read once at module load. */
export const DIRECT_PORT = readPositiveIntEnv("GUARDIAN_DIRECT_PORT", 3830);

/**
 * A session is considered "still active" if used within this window — the
 * grace period the S4 lifecycle-aware eviction redesign (#586) uses in TWO
 * places that must share exactly one definition of "active": the ownership
 * table's soft-cap eviction filter (state-db.ts) and the reconciliation
 * sweep's upstream activity check (reconciliation.ts). Recommended default
 * 24h (decision 586-2). Read once at module load; both call sites also
 * accept an explicit override for tests.
 */
export const SESSION_ACTIVE_GRACE_MS = readPositiveIntEnv("GUARDIAN_SESSION_ACTIVE_GRACE_MS", 24 * 60 * 60 * 1000);

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

/**
 * Guardian upstream Basic auth to the assistant.
 *
 * The assistant's OpenCode requires a password in EVERY configuration, so the
 * guardian's calls over `assistant_net` always carry one. This resolves the
 * same env var the assistant's compose service and entrypoint use into a
 * ready-to-attach `authorization` header value, fail-closed at boot: a
 * missing/empty password file is a boot error naming the var, never a silent
 * 401 storm at request time.
 *
 * It used to be gated on `OPENCODE_AUTH`, which tracked whether the assistant
 * port was published — so the guardian attached a credential only when the
 * operator had flipped a network toggle, and the assistant, the guardian and
 * two healthchecks each had to reach the same verdict about that flag. There
 * is no flag left to disagree about.
 */
export type AssistantUpstreamAuth = { authorization: string };

export function resolveAssistantUpstreamAuth(
  env: Record<string, string | undefined>,
  readFileFn: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): AssistantUpstreamAuth {
  const passwordFile = env.OPENCODE_SERVER_PASSWORD_FILE || "";
  if (!passwordFile) {
    throw new Error(
      "OPENCODE_SERVER_PASSWORD_FILE is not set — the guardian cannot authenticate its upstream assistant calls, and the assistant always requires a credential.",
    );
  }

  let raw: string;
  try {
    raw = readFileFn(passwordFile);
  } catch (err) {
    throw new Error(
      `OPENCODE_SERVER_PASSWORD_FILE (${passwordFile}) could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // PR #564 r3566888272: match the assistant entrypoint, which reads the same
  // secret with `$(cat file)` — command substitution strips ONLY trailing
  // newlines, preserving surrounding spaces/tabs. Using `.trim()` here diverged
  // (guardian sent a differently-trimmed password than OpenCode expected → a
  // silent 401 storm on every upstream call). Strip trailing newlines only; a
  // whitespace-only file is still rejected as empty.
  const password = raw.replace(/\n+$/, "");
  if (password.trim() === "") {
    throw new Error(
      `OPENCODE_SERVER_PASSWORD_FILE (${passwordFile}) is empty — the assistant always requires a credential.`,
    );
  }

  // PR #564 r3566889740: honor OPENCODE_SERVER_USERNAME (default 'opencode'),
  // matching the host UI (endpoints.ts) so an operator override doesn't 401.
  const username = env.OPENCODE_SERVER_USERNAME || "opencode";
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf-8").toString("base64")}` };
}

let cachedUpstreamAuth: AssistantUpstreamAuth | undefined;

/**
 * The upstream credential, resolved once and cached.
 *
 * Resolved on FIRST USE rather than at module load. While this was gated on
 * `OPENCODE_AUTH` a module-load call was harmless — it returned null in any
 * environment without the flag. Unconditional, it would throw during `import`
 * for anything that touches this module without the compose secret mounted:
 * a test, a CLI tool, a type-check harness. Boot-time fail-fast is still the
 * behaviour that matters, and {@link assertAssistantUpstreamAuth} is how the
 * server asks for it explicitly at startup.
 */
export function assistantUpstreamAuth(): AssistantUpstreamAuth {
  cachedUpstreamAuth ??= resolveAssistantUpstreamAuth(Bun.env);
  return cachedUpstreamAuth;
}

/**
 * Resolve the upstream credential at startup so a missing secret is a boot
 * failure, not a 401 storm on the first portal message. Call once from the
 * server entry points.
 */
export function assertAssistantUpstreamAuth(): void {
  assistantUpstreamAuth();
}

/** Sets `authorization` for an upstream assistant call. Always attaches — the assistant always requires it. */
export function withAssistantUpstreamAuth(headers: Headers): Headers {
  headers.set("authorization", assistantUpstreamAuth().authorization);
  return headers;
}
