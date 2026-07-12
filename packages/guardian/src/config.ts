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

/**
 * Opt-in mTLS adapter transport identity on the direct listener (spec 435,
 * D3). `GUARDIAN_TLS_CERT_FILE` / `GUARDIAN_TLS_KEY_FILE` /
 * `GUARDIAN_MTLS_CA_FILE` must all be set (mTLS on) or all be unset/empty
 * (off, the default) — no server-only-TLS mode, and no partial config: any
 * other combination fails closed at module load (boot error) naming the
 * missing variable(s). Values here are file PATHS only; contents are read
 * later by the caller (`server.ts`).
 */
export type DirectTlsConfig =
  | { mode: 'off' }
  | { mode: 'mtls'; certPath: string; keyPath: string; caPath: string };

export function parseDirectTlsEnv(env: Record<string, string | undefined>): DirectTlsConfig {
  const certPath = env.GUARDIAN_TLS_CERT_FILE || '';
  const keyPath = env.GUARDIAN_TLS_KEY_FILE || '';
  const caPath = env.GUARDIAN_MTLS_CA_FILE || '';

  if (!certPath && !keyPath && !caPath) return { mode: 'off' };
  if (certPath && keyPath && caPath) return { mode: 'mtls', certPath, keyPath, caPath };

  const missing: string[] = [];
  if (!certPath) missing.push('GUARDIAN_TLS_CERT_FILE');
  if (!keyPath) missing.push('GUARDIAN_TLS_KEY_FILE');
  if (!caPath) missing.push('GUARDIAN_MTLS_CA_FILE');
  throw new Error(
    `Guardian direct-listener TLS config is partial: all three of GUARDIAN_TLS_CERT_FILE, GUARDIAN_TLS_KEY_FILE, and GUARDIAN_MTLS_CA_FILE must be set together (mTLS on) or all left unset/empty (off). Missing: ${missing.join(', ')}.`,
  );
}

/** Read once at module load, matching the CORS-parser idiom above. */
export const DIRECT_TLS = parseDirectTlsEnv(Bun.env);

/**
 * #563 D2 — guardian upstream Basic auth to the assistant.
 *
 * When a network access preset turns the assistant's own OpenCode auth on
 * (`OPENCODE_AUTH=true` + the operator's password in the `op_opencode_password`
 * secret), the guardian's calls to the assistant over `assistant_net` would
 * otherwise 401 — breaking every portal. This resolves the same two env vars
 * the assistant's compose service and entrypoint use into a ready-to-attach
 * `authorization` header value, fail-closed at boot: auth enabled with a
 * missing/empty password file is a boot error naming both vars (mirrors the
 * `parseDirectTlsEnv` idiom above), never a silent 401 storm at request time.
 * Gating on `OPENCODE_AUTH` (not on file presence, since the secret file is
 * now ALWAYS materialized, #563/D3) keeps the default posture byte-identical:
 * no header is ever attached unless the operator turned auth on.
 */
export type AssistantUpstreamAuth = { authorization: string };

const UPSTREAM_AUTH_TRUTHY_RE = /^(true|1|yes)$/i;

export function resolveAssistantUpstreamAuth(
  env: Record<string, string | undefined>,
  readFileFn: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): AssistantUpstreamAuth | null {
  if (!UPSTREAM_AUTH_TRUTHY_RE.test((env.OPENCODE_AUTH ?? "").trim())) return null;

  const passwordFile = env.OPENCODE_SERVER_PASSWORD_FILE || "";
  if (!passwordFile) {
    throw new Error(
      "OPENCODE_AUTH is enabled but OPENCODE_SERVER_PASSWORD_FILE is not set — the guardian cannot authenticate its upstream assistant calls.",
    );
  }

  let raw: string;
  try {
    raw = readFileFn(passwordFile);
  } catch (err) {
    throw new Error(
      `OPENCODE_AUTH is enabled but OPENCODE_SERVER_PASSWORD_FILE (${passwordFile}) could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const password = raw.trim();
  if (!password) {
    throw new Error(
      `OPENCODE_AUTH is enabled but OPENCODE_SERVER_PASSWORD_FILE (${passwordFile}) is empty.`,
    );
  }

  return { authorization: `Basic ${Buffer.from(`opencode:${password}`, "utf-8").toString("base64")}` };
}

/** Read once at module load, matching the DIRECT_TLS idiom. */
export const ASSISTANT_UPSTREAM_AUTH = resolveAssistantUpstreamAuth(Bun.env);

/** Sets `authorization` from ASSISTANT_UPSTREAM_AUTH when configured; no-op otherwise. */
export function withAssistantUpstreamAuth(headers: Headers): Headers {
  if (ASSISTANT_UPSTREAM_AUTH) headers.set("authorization", ASSISTANT_UPSTREAM_AUTH.authorization);
  return headers;
}
