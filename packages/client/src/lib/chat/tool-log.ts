/**
 * Pure presentation helpers for the client's ToolLog rail (review 2026-07-10
 * §B9 — tool-activity visibility was entirely lost: long tool-running turns
 * were an opaque, uninterruptible wait). Ported/trimmed from
 * packages/ui/src/lib/chat/tool-strip.ts: the client transport only extracts
 * live TOOL updates (extractToolUpdate), never 'step' updates, so every
 * `kind`-branch in the host version collapses to the tool case here.
 *
 * Kept free of component/DOM state so ToolLog.svelte stays a thin renderer —
 * same split as $lib/markdown.ts / $lib/chat/copy.ts in this package.
 */
import type { ToolStateSnapshot } from '../transport/index.js';

export type ToolDetailRow = { label: string; value: string; tone?: 'default' | 'error' };

/** Icon family for a tool, keyed off its name + status. */
export type ToolIconType =
  | 'alert'
  | 'done-circle'
  | 'refresh'
  | 'terminal'
  | 'search'
  | 'file'
  | 'edit'
  | 'link'
  | 'agent'
  | 'done'
  | 'clock';

function parseStructured(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    !((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))
  ) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Pretty-print a detail/output value: JSON in, indented JSON out; else pass through. */
export function formatDetail(value: string): string {
  const structured = parseStructured(value);
  return structured === null ? value : JSON.stringify(structured, null, 2);
}

function prettyLabel(label: string): string {
  if (!label) return '';
  return label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

/** Icon family for a tool row, keyed off its name + status (failure always wins). */
export function toolIconType(tool: string, status: string): ToolIconType {
  const name = tool.toLowerCase();
  if (status === 'error' || status === 'failed') return 'alert';
  if (name.includes('remember') || name.includes('memory')) return 'edit';
  if (name.includes('help') || name.includes('todo')) {
    return status === 'completed' ? 'done' : 'agent';
  }
  if (name.includes('bash') || name.includes('shell') || name.includes('command')) return 'terminal';
  if (name.includes('grep') || name.includes('search')) return 'search';
  if (name.includes('read') || name.includes('file')) return 'file';
  if (name.includes('edit') || name.includes('write') || name.includes('patch')) return 'edit';
  if (name.includes('web') || name.includes('http') || name.includes('fetch')) return 'link';
  if (name.includes('task') || name.includes('agent')) return 'agent';
  return status === 'completed' ? 'done' : 'clock';
}

/** Raw title, falling back to the tool name. */
export function timelineTitle(entry: ToolStateSnapshot): string {
  return entry.title || entry.tool;
}

export function toolStatusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
    case 'failed':
      return 'failed';
    case 'pending':
      return 'queued';
    default:
      return 'running';
  }
}

export function toolAriaLabel(entry: ToolStateSnapshot): string {
  return `Tool: ${timelineTitle(entry)} (${toolStatusLabel(entry.status)})`;
}

export function toolDetailRows(entry: ToolStateSnapshot): ToolDetailRow[] {
  const rows: ToolDetailRow[] = [
    { label: 'Name', value: timelineTitle(entry) },
    { label: 'Status', value: prettyLabel(toolStatusLabel(entry.status)) },
    { label: 'Tool ID', value: entry.tool },
  ];

  if (entry.detail) {
    rows.push({ label: 'Input / Details', value: formatDetail(entry.detail) });
  }
  if (entry.output) {
    rows.push({ label: 'Output', value: formatDetail(entry.output) });
  }
  if (entry.error) {
    rows.push({ label: 'Error', value: formatDetail(entry.error), tone: 'error' });
  }

  return rows;
}

/**
 * Relative time label: "just now" (<45s), "Nm ago" (<60m), "Nh ago" (<24h),
 * "Nd ago" otherwise. Returns "" for a falsy timestamp and "just now" for a
 * future one.
 */
export function relativeTimeLabel(updatedAt: number, now: number = Date.now()): string {
  if (!updatedAt) return '';
  const diff = now - updatedAt;
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── User-facing summarization ────────────────────────────────────────────
// De-credentialed, friendly phrasing for raw tool/command titles.

const SECRET_SIGNAL = /(token|secret|password|key\s*=|key=)/i;

const COMMAND_PHRASES: Array<{ prefix: string; phrase: string }> = [
  { prefix: 'gh auth login', phrase: 'Signed in to GitHub' },
  { prefix: 'gh auth status', phrase: 'Checked GitHub sign-in' },
  { prefix: 'gh auth', phrase: 'Set up GitHub access' },
  { prefix: 'gh repo', phrase: 'Looked up a GitHub repo' },
  { prefix: 'gh ', phrase: 'Ran a GitHub command' },
  { prefix: 'git config', phrase: 'Configured git' },
  { prefix: 'git ', phrase: 'Ran a git command' },
  { prefix: 'cat ', phrase: 'Read a file' },
  { prefix: 'ls ', phrase: 'Listed files' },
  { prefix: 'grep', phrase: 'Searched files' },
  { prefix: 'rg ', phrase: 'Searched files' },
];

function stripLeadingAssignments(input: string): string {
  let out = input;
  while (/^[A-Z_][A-Z0-9_]*=\S+\s+/.test(out)) {
    out = out.replace(/^[A-Z_][A-Z0-9_]*=\S+\s+/, '');
  }
  return out;
}

function firstCommandSegment(input: string): string {
  let out = input;
  for (const sep of [' && ', ' || ', ' | ', ' ; ']) {
    const idx = out.indexOf(sep);
    if (idx >= 0) out = out.slice(0, idx);
  }
  return out.trim();
}

function phraseForCommand(cleaned: string): string | null {
  const lower = cleaned.toLowerCase();
  for (const { prefix, phrase } of COMMAND_PHRASES) {
    if (lower.startsWith(prefix)) return phrase;
  }
  return null;
}

/**
 * Human-readable, de-credentialed summary for a row title. Never throws and
 * never returns an empty string; strips leading env-var/token assignments
 * and refuses to surface raw commands that contain secret material.
 */
export function displayTitle(entry: ToolStateSnapshot): string {
  try {
    const raw = (entry.title || entry.tool || '').trim();
    const name = (entry.tool || '').toLowerCase();

    if (raw) {
      const stripped = stripLeadingAssignments(raw);
      const segment = firstCommandSegment(stripped);

      if (segment) {
        const matched = phraseForCommand(segment);
        if (matched) return matched;

        if (SECRET_SIGNAL.test(segment)) {
          const verb = segment.split(/\s+/)[0] || '';
          return verb ? `Ran a ${verb} command` : 'Ran a command';
        }

        if (name.includes('read') || name.includes('file')) return 'Read a file';
        if (name.includes('edit') || name.includes('write') || name.includes('patch')) return 'Edited a file';
        if (name.includes('grep') || name.includes('search')) return 'Searched';
        if (name.includes('task') || name.includes('agent')) return entry.title;

        return segment.replace(/^./, (char) => char.toUpperCase());
      }
    }

    if (name.includes('read') || name.includes('file')) return 'Read a file';
    if (name.includes('edit') || name.includes('write') || name.includes('patch')) return 'Edited a file';
    if (name.includes('grep') || name.includes('search')) return 'Searched';
    if (name.includes('task') || name.includes('agent')) return entry.title || entry.tool || 'Worked';

    return raw || entry.tool || 'Worked';
  } catch {
    return entry.title || entry.tool || 'Worked';
  }
}
