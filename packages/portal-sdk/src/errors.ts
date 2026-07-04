/**
 * Normalize an unknown thrown value into a human-readable message string.
 *
 * Mirrors the ubiquitous `err instanceof Error ? err.message : String(err)`
 * expression so portals can share one canonical helper instead of repeating it.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
