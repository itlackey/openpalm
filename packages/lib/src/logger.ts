export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * In-house redactor. Returns `'***REDACTED***'` when `key` names something
 * that looks like a secret (token, key, secret, password, hmac). Replaces
 * the value-masking that varlock used to do for log output.
 *
 * The pattern matches the bare word at the start or end of the key, using
 * underscore as a word boundary. This avoids substring false positives
 * like `MONKEY` (contains `_KEY`? no, but the un-anchored pattern used
 * to match the substring `KEY` even without an underscore) and
 * `PACKET_SIZE` (does not actually contain `_KEY`, but the regex engine
 * with un-anchored alternations was sloppy enough to invite future bugs).
 *
 * Examples:
 *   OP_UI_LOGIN_PASSWORD → sensitive (suffix _PASSWORD)
 *   CHANNEL_API_KEY    → sensitive (suffix _KEY)
 *   CHANNEL_FOO_HMAC   → sensitive (suffix _HMAC)
 *   HMAC_KEY           → sensitive (prefix HMAC_, suffix _KEY)
 *   TOKEN              → sensitive (bare word)
 *   MONKEY             → NOT sensitive
 *   PACKET_SIZE        → NOT sensitive
 *
 * The same predicate is exported as {@link isSensitiveEnvKey} so callers
 * that need to mask only part of a larger payload can short-circuit.
 */
const REDACT_PATTERN = /(?:^|_)(?:TOKEN|SECRET|KEY|PASSWORD|HMAC)(?:_|$)/i;

export function isSensitiveEnvKey(key: string): boolean {
  return REDACT_PATTERN.test(key);
}

export function redactValue(key: string, value: string): string {
  return isSensitiveEnvKey(key) ? '***REDACTED***' : value;
}

/**
 * Recursively walk a structured `extra` payload and mask every value whose
 * own key (or the nearest enclosing object key) matches the sensitivity
 * pattern. The original object is not mutated. Sensitive values of any
 * primitive type (string, number, boolean) are replaced wholesale; nested
 * objects under a sensitive key are still walked so that callers can mix
 * structured payloads with redacted leaves.
 */
export function redactExtra<T>(extra: T): T {
  if (extra == null || typeof extra !== 'object') return extra;
  if (Array.isArray(extra)) {
    return extra.map((v) => (v && typeof v === 'object' ? redactExtra(v) : v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
    if (isSensitiveEnvKey(k)) {
      // Redact any non-null primitive (string/number/boolean) under a
      // sensitive key. Nested objects keep being walked so a structured
      // payload like { credentials: { ... } } still gets per-field masking.
      if (v && typeof v === 'object') {
        out[k] = redactExtra(v);
      } else if (v == null) {
        out[k] = v;
      } else {
        out[k] = '***REDACTED***';
      }
    } else if (v && typeof v === 'object') {
      out[k] = redactExtra(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function createLogger(service: string) {
  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const safeExtra = extra ? redactExtra(extra) : undefined;
    const entry = { ts: new Date().toISOString(), level, service, msg, ...(safeExtra ? { extra: safeExtra } : {}) };
    (level === 'error' || level === 'warn' ? console.error : console.log)(JSON.stringify(entry));
  }
  return {
    info: (msg: string, extra?: Record<string, unknown>) => log('info', msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log('warn', msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log('error', msg, extra),
    debug: (msg: string, extra?: Record<string, unknown>) => log('debug', msg, extra),
  };
}
