/** Small error-handling utilities shared across the control plane. */

/**
 * Normalize an unknown thrown value to a human-readable message string.
 *
 * Replaces the `err instanceof Error ? err.message : String(err)` idiom that
 * recurs across control-plane modules. An `Error` yields its `message`; anything
 * else is coerced with `String(...)`.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
