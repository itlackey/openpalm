export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * In-house redactor. Returns `'***REDACTED***'` when `key` names something
 * that looks like a secret (token, key, secret, password). Replaces the
 * value-masking that varlock used to do for log output. Keys are matched
 * case-insensitively against the suffix patterns we care about.
 *
 * The same predicate is exported as {@link isSensitiveEnvKey} so callers
 * that need to mask only part of a larger payload can short-circuit.
 */
const REDACT_PATTERN = /_TOKEN|_SECRET|_KEY|_PASSWORD/i;

export function isSensitiveEnvKey(key: string): boolean {
  return REDACT_PATTERN.test(key);
}

export function redactValue(key: string, value: string): string {
  return isSensitiveEnvKey(key) ? '***REDACTED***' : value;
}

/**
 * Recursively walk a structured `extra` payload and mask every value whose
 * own key (or the nearest enclosing object key) matches the sensitivity
 * pattern. The original object is not mutated.
 */
export function redactExtra<T>(extra: T): T {
  if (extra == null || typeof extra !== 'object') return extra;
  if (Array.isArray(extra)) {
    return extra.map((v) => (v && typeof v === 'object' ? redactExtra(v) : v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
    if (isSensitiveEnvKey(k) && typeof v === 'string') {
      out[k] = '***REDACTED***';
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
