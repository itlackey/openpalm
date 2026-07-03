export type OutputFormat = 'json' | 'human';

/**
 * Normalize and validate a `--format` argument shared by the reporting
 * commands (`scan`, `audit-secrets`). Case-insensitive; defaults to `json`
 * when unset. Returns `null` for any unrecognized value so the caller can
 * emit its own message and pick the exit code (both callers exit 2).
 */
export function parseOutputFormat(raw: unknown): OutputFormat | null {
  const format = String(raw ?? 'json').toLowerCase();
  return format === 'json' || format === 'human' ? format : null;
}
