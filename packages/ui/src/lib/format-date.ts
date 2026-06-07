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
