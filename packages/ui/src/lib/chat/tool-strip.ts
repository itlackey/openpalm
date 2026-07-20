export type ToolStripEntry = {
  id: string;
  kind: 'tool' | 'step';
  tool: string;
  status: string;
  title: string;
  detail: string;
  output: string;
  error: string;
  updatedAt: number;
  /** Grouping key for the user turn that initiated this activity. */
  turnKey?: string;
};

export type ToolOutcome =
  | 'succeeded'
  | 'running'
  | 'failed'
  | 'warning'
  | 'stopped'
  | 'uncertain';

export type SessionMessagePart = {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  id?: string;
  state?: {
    status?: string;
    title?: string;
    input?: unknown;
    metadata?: unknown;
    progress?: unknown;
    output?: unknown;
    error?: string;
    time?: {
      start?: number;
      end?: number;
    };
  };
};

function valueToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = valueToText(value);
    if (text) return text;
  }
  return '';
}

function hasSemanticFailure(value: unknown): boolean {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return false;
    }
  }
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    (candidate as { ok?: unknown }).ok === false
  );
}

export function normalizeToolStatus(
  status: string,
  output?: unknown,
  error?: string,
): ToolOutcome {
  const name = status.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (error || name === 'error' || name === 'failed' || name === 'failure') return 'failed';
  if (
    name === 'stopped' ||
    name === 'cancelled' ||
    name === 'canceled' ||
    name === 'aborted' ||
    name === 'interrupted'
  ) {
    return 'stopped';
  }
  if (hasSemanticFailure(output) || name === 'warning' || name === 'completedwithwarning') {
    return 'warning';
  }
  if (
    name === 'completed' ||
    name === 'complete' ||
    name === 'done' ||
    name === 'success' ||
    name === 'succeeded'
  ) {
    return 'succeeded';
  }
  if (
    !name ||
    name === 'pending' ||
    name === 'queued' ||
    name === 'called' ||
    name === 'running' ||
    name === 'inprogress'
  ) {
    return 'running';
  }
  return 'uncertain';
}

const TOOL_OUTCOMES: ReadonlySet<string> = new Set<ToolOutcome>([
  'succeeded',
  'running',
  'failed',
  'warning',
  'stopped',
  'uncertain',
]);

export function toolOutcome(entry: ToolStripEntry): ToolOutcome {
  // Every ingestion site (chat-state _upsertPendingToolState / _appendStep and
  // toolStripEntryFromSessionPart) already stores a normalized ToolOutcome in
  // `status`. Re-normalizing here re-ran hasSemanticFailure() — a JSON.parse of
  // the (possibly large) tool output — on every derived recompute and 3-4× per
  // ToolLog row per render. Return the stored outcome directly when it's
  // already normalized; fall back only for a raw/legacy status.
  if (TOOL_OUTCOMES.has(entry.status)) return entry.status as ToolOutcome;
  return normalizeToolStatus(entry.status, entry.output, entry.error);
}

export function toolStripEntryFromSessionPart(
  part: SessionMessagePart,
  fallbackId: string,
  fallbackTimestamp = 0,
): ToolStripEntry | null {
  if (part.type !== 'tool' && !part.state) return null;

  const output = valueToText(part.state?.output);
  const error = part.state?.error ?? '';
  return {
    id: part.callID ?? part.id ?? fallbackId,
    kind: 'tool',
    tool: part.tool ?? 'tool',
    status: normalizeToolStatus(part.state?.status ?? 'running', part.state?.output, error),
    title: part.state?.title ?? part.tool ?? 'tool',
    detail: firstText(part.state?.input, part.state?.metadata, part.state?.progress, part.state?.output),
    output,
    error,
    updatedAt: part.state?.time?.end ?? part.state?.time?.start ?? fallbackTimestamp,
  };
}

// ── Presentation helpers ───────────────────────────────────────────────────
// Pure formatters shared by the inline ToolStrip (admin activity) and the
// chat-page tool accordion (ToolLog). Keep these free of component state so
// both renderers stay in lockstep.

export type ToolDetailRow = { label: string; value: string; tone?: 'default' | 'error' };

/** Icon family for a tool/step, keyed off its name + status. */
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
    !((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')))
  ) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function formatDetail(value: string): string {
  const structured = parseStructured(value);
  return structured === null ? value : JSON.stringify(structured, null, 2);
}

export function prettyLabel(label: string): string {
  if (!label) return '';
  return label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

export function toolIconType(tool: string, status: string): ToolIconType {
  const name = tool.toLowerCase();
  const outcome = normalizeToolStatus(status);
  if (outcome === 'failed' || outcome === 'warning') return 'alert';
  if (name === 'step') return outcome === 'succeeded' ? 'done-circle' : 'refresh';
  // More specific checks first so exact names like akm_remember / akm_help get
  // sensible icons before the generic substring heuristics below.
  if (name.includes('remember') || name.includes('memory')) return 'edit';
  if (name.includes('help') || name.includes('todo')) {
    return outcome === 'succeeded' ? 'done' : 'agent';
  }
  if (name.includes('bash') || name.includes('shell') || name.includes('command')) return 'terminal';
  if (name.includes('grep') || name.includes('search')) return 'search';
  if (name.includes('read') || name.includes('file')) return 'file';
  if (name.includes('edit') || name.includes('write') || name.includes('patch')) return 'edit';
  if (name.includes('web') || name.includes('http') || name.includes('fetch')) return 'link';
  if (name.includes('task') || name.includes('agent')) return 'agent';
  return outcome === 'succeeded' ? 'done' : 'clock';
}

export function timelineTitle(entry: ToolStripEntry): string {
  return entry.kind === 'step' ? entry.title : entry.title || entry.tool;
}

export function toolKindLabel(entry: ToolStripEntry): string {
  return entry.kind === 'step' ? 'Step' : 'Tool';
}

export function toolStatusLabel(entryOrStatus: ToolStripEntry | string): string {
  const outcome =
    typeof entryOrStatus === 'string'
      ? normalizeToolStatus(entryOrStatus)
      : toolOutcome(entryOrStatus);
  switch (outcome) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'warning':
      return 'completed with warning';
    case 'stopped':
      return 'stopped';
    case 'uncertain':
      return 'outcome uncertain';
    case 'running':
      return 'running';
  }
}

export function toolAriaLabel(entry: ToolStripEntry): string {
  return `${toolKindLabel(entry)}: ${timelineTitle(entry)} (${toolStatusLabel(entry)})`;
}

export function toolDetailRows(entry: ToolStripEntry): ToolDetailRow[] {
  const rows: ToolDetailRow[] = [
    { label: 'Type', value: toolKindLabel(entry) },
    { label: 'Name', value: timelineTitle(entry) },
    { label: 'Status', value: prettyLabel(toolStatusLabel(entry)) },
  ];

  if (entry.kind !== 'step') {
    rows.push({ label: 'Tool ID', value: entry.tool });
  }

  if (entry.detail) {
    rows.push({
      label: entry.kind === 'step' ? 'Details' : 'Input / Details',
      value: formatDetail(entry.detail),
    });
  }

  if (entry.output) {
    rows.push({ label: 'Output', value: formatDetail(entry.output) });
  }

  if (entry.error) {
    rows.push({ label: 'Error', value: formatDetail(entry.error), tone: 'error' });
  }

  return rows;
}

// ── User-facing summarization ───────────────────────────────────────────────
// Helpers that turn raw tool/command titles into friendly, de-credentialed
// phrases for the non-technical home-user activity log.

/** Patterns that indicate a command is carrying or referencing a secret. */
const SECRET_SIGNAL = /(token|secret|password|key\s*=|key=)/i;

/** Cleaned-first-segment prefix → friendly verb phrase. Order matters: more
 * specific prefixes must be checked before their broader siblings. */
const COMMAND_PHRASES: Array<{ prefix: string; phrase: string }> = [
  { prefix: 'gh auth login', phrase: 'Signed in to GitHub' },
  { prefix: 'gh auth status', phrase: 'Checked GitHub sign-in' },
  { prefix: 'gh auth', phrase: 'Set up GitHub access' },
  { prefix: 'gh repo', phrase: 'Looked up a GitHub repo' },
  { prefix: 'gh ', phrase: 'Ran a GitHub command' },
  { prefix: 'git config', phrase: 'Configured git' },
  { prefix: 'git ', phrase: 'Ran a git command' },
  { prefix: 'akm add', phrase: 'Added a knowledge source' },
  { prefix: 'akm remove', phrase: 'Removed a knowledge source' },
  { prefix: 'akm ', phrase: 'Updated knowledge' },
  { prefix: 'cat ', phrase: 'Read a file' },
  { prefix: 'ls ', phrase: 'Listed files' },
  { prefix: 'grep', phrase: 'Searched files' },
  { prefix: 'rg ', phrase: 'Searched files' },
];

/** Strip leading `VAR=value ` env-var/token assignments repeatedly. */
function stripLeadingAssignments(input: string): string {
  let out = input;
  // e.g. `GH_TOKEN=$(gh auth token) akm add x` -> `akm add x`
  while (/^[A-Z_][A-Z0-9_]*=\S+\s+/.test(out)) {
    out = out.replace(/^[A-Z_][A-Z0-9_]*=\S+\s+/, '');
  }
  return out;
}

/** Keep only the first command segment (before chaining/pipe operators). */
function firstCommandSegment(input: string): string {
  let out = input;
  for (const sep of [' && ', ' || ', ' | ', ' ; ']) {
    const idx = out.indexOf(sep);
    if (idx >= 0) out = out.slice(0, idx);
  }
  return out.trim();
}

/** Match a cleaned command against the friendly phrase table. */
function phraseForCommand(cleaned: string): string | null {
  const lower = cleaned.toLowerCase();
  for (const { prefix, phrase } of COMMAND_PHRASES) {
    if (lower.startsWith(prefix)) return phrase;
  }
  return null;
}

/**
 * Human-readable, de-credentialed summary for a row title. Audience is
 * non-technical home users. Never throws and never returns an empty string.
 * Strips leading env-var/token assignments and refuses to surface raw commands
 * that contain secret material.
 */
export function displayTitle(entry: ToolStripEntry): string {
  try {
    if (entry.kind === 'step') return entry.title;

    const raw = (entry.title || entry.tool || '').trim();
    const name = (entry.tool || '').toLowerCase();

    if (raw) {
      // Strip leading credential assignments first, then take the first segment.
      const stripped = stripLeadingAssignments(raw);
      const segment = firstCommandSegment(stripped);

      if (segment) {
        const matched = phraseForCommand(segment);
        if (matched) return matched;

        // Secret material present and no friendly phrase matched: never surface
        // the raw command — fall back to a generic phrase for the first verb.
        if (SECRET_SIGNAL.test(segment)) {
          const verb = segment.split(/\s+/)[0] || '';
          return verb ? `Ran a ${verb} command` : 'Ran a command';
        }

        // Non-bash tool-name fallbacks.
        if (name.includes('read') || name.includes('file')) return 'Read a file';
        if (name.includes('edit') || name.includes('write') || name.includes('patch')) {
          return 'Edited a file';
        }
        if (name.includes('grep') || name.includes('search')) return 'Searched';
        if (name.includes('task') || name.includes('agent')) return entry.title;

        return segment.replace(/^./, (char) => char.toUpperCase());
      }
    }

    // No usable title — derive from the tool name.
    if (name.includes('read') || name.includes('file')) return 'Read a file';
    if (name.includes('edit') || name.includes('write') || name.includes('patch')) {
      return 'Edited a file';
    }
    if (name.includes('grep') || name.includes('search')) return 'Searched';
    if (name.includes('task') || name.includes('agent')) return entry.title || entry.tool || 'Worked';

    return raw || entry.tool || 'Worked';
  } catch {
    return entry.title || entry.tool || 'Worked';
  }
}

/**
 * Relative time label: "just now" (<45s), "Nm ago" (<60m), "Nh ago" (<24h),
 * "Nd ago" otherwise. Returns "" for falsy/zero timestamps and "just now" for
 * future timestamps.
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

/**
 * Whether a tool entry should appear in the user-facing activity log. Filters
 * out internal todo-writer bookkeeping but never hides a failure.
 */
export function isUserFacingTool(entry: ToolStripEntry): boolean {
  const outcome = toolOutcome(entry);
  if (outcome === 'failed' || outcome === 'warning' || outcome === 'stopped' || outcome === 'uncertain') {
    return true;
  }

  const name = (entry.tool || '').toLowerCase();
  if (name === 'todowrite' || name === 'todoread') return false;

  const label = entry.title || entry.tool || '';
  if (/^\d+\s+todos?$/i.test(label)) return false;

  return true;
}
