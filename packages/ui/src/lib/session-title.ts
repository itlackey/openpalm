import { formatDateTime } from '$lib/format-date.js';

// OpenCode assigns a default title of the form "New session - <ISO timestamp>"
// when it fails to auto-name a session at creation time. Detect that default and
// render the timestamp through the shared date formatter so it reads as a normal
// date/time instead of a raw ISO string. Any real (model-named) or
// channel-derived title is passed through unchanged.
const DEFAULT_TITLE_RE = /^New session - (\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)$/;

/** Resolve a session's display title. */
export function resolveSessionTitle(title: string | null | undefined): string {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return 'Untitled session';
  const match = DEFAULT_TITLE_RE.exec(trimmed);
  if (match) {
    const ts = Date.parse(match[1]);
    if (!Number.isNaN(ts)) return formatDateTime(ts);
  }
  return trimmed;
}
