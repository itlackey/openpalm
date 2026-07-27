/**
 * Single shared human-readable byte formatter (S6/S7/S8 diagnostics).
 *
 * Pulled out on its own so `disk-headroom.ts`, `storage-report.ts`, and the
 * CLI `doctor` command all render sizes identically instead of each keeping
 * a private copy that can drift.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
