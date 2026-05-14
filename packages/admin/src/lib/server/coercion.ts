/**
 * Shared `unknown` -> typed coercion helpers used by API routes and
 * server-side logic that consumes opaque JSON (e.g. OpenCode config blobs).
 *
 * Each helper returns `undefined` when the value does not match the expected
 * shape. Object helpers shallow-clone so callers can mutate without leaking
 * back into shared state.
 */

/** Narrow `unknown` to a plain-object record. Returns a shallow clone. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? ({ ...value } as Record<string, unknown>)
    : undefined;
}

/** Narrow `unknown` to a string. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Narrow `unknown` to a number. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Narrow `unknown` to an array of strings. Drops non-string entries. */
export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === 'string') : undefined;
}

/** Narrow `unknown` to a `Record<string, string>`. Returns `undefined` when empty. */
export function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
