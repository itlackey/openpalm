// Centralized date/time formatting so every timestamp in the UI renders with a
// consistent, locale-aware format. All inputs are epoch milliseconds — the shape
// used by sessions (updatedAt), chat entries (timestamp), and admin status.
//
// Use these instead of ad-hoc `new Date(x).toLocaleTimeString()` calls so the
// format stays uniform across components.

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const DATE_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Time of day, e.g. "3:42 PM" (locale-aware). Empty string for a falsy input. */
export function formatTime(ts: number): string {
  if (!ts) return '';
  return TIME_FMT.format(ts);
}

/**
 * Absolute date + time, e.g. "Jun 7, 2026, 3:42 PM". Use for tooltips / full
 * context where a relative label alone is ambiguous. Empty for a falsy input.
 */
export function formatDateTime(ts: number): string {
  if (!ts) return '';
  return DATE_TIME_FMT.format(ts);
}

/**
 * Absolute date + time from a date string (ISO-8601 or anything `Date` accepts),
 * rendered with the runtime locale via `toLocaleString()`. Unlike the epoch-ms
 * helpers above, this takes the string shape returned by admin/AKM endpoints.
 * Returns `fallback` (default em dash) for null/empty or unparseable input.
 */
export function formatDate(value: string | null | undefined, fallback = '—'): string {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toLocaleString();
}

/**
 * Human-readable byte size, e.g. "512 B", "1.5 KB", "2.0 MB". Scales through
 * B/KB/MB/GB/TB (binary, 1024-based) with adaptive precision: whole numbers for
 * bytes and for values ≥ 10, one decimal otherwise. Em dash for non-finite input.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Compact relative time, e.g. "just now", "5m ago", "yesterday", "3w ago".
 * Empty string for a falsy input. No date-fns dependency — that would be ~30 KB
 * for these few cases.
 */
export function formatRelativeTime(ts: number): string {
  if (!ts) return '';
  const diffSec = Math.max(0, (Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}
