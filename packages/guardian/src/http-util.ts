/**
 * Shared HTTP helpers used across the guardian request handlers.
 */

/** Build a JSON Response with the given status and body. */
export function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

/** Narrow an unknown value to a plain object record, or null if it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
