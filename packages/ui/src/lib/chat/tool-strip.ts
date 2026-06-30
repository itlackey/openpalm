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
};

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

export function toolStripEntryFromSessionPart(
  part: SessionMessagePart,
  fallbackId: string,
): ToolStripEntry | null {
  if (part.type !== 'tool' && !part.state) return null;

  const status = part.state?.status ?? 'running';
  return {
    id: part.callID ?? part.id ?? fallbackId,
    kind: 'tool',
    tool: part.tool ?? 'tool',
    status,
    title: part.state?.title ?? part.tool ?? 'tool',
    detail: firstText(part.state?.input, part.state?.metadata, part.state?.progress, part.state?.output),
    output: valueToText(part.state?.output),
    error: part.state?.error ?? '',
    updatedAt: Date.now(),
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
  if (status === 'error' || status === 'failed') return 'alert';
  if (name === 'step') return status === 'completed' ? 'done-circle' : 'refresh';
  if (name.includes('bash') || name.includes('shell') || name.includes('command')) return 'terminal';
  if (name.includes('grep') || name.includes('search')) return 'search';
  if (name.includes('read') || name.includes('file')) return 'file';
  if (name.includes('edit') || name.includes('write') || name.includes('patch')) return 'edit';
  if (name.includes('web') || name.includes('http') || name.includes('fetch')) return 'link';
  if (name.includes('task') || name.includes('agent')) return 'agent';
  return status === 'completed' ? 'done' : 'clock';
}

export function timelineTitle(entry: ToolStripEntry): string {
  return entry.kind === 'step' ? entry.title : entry.title || entry.tool;
}

export function toolKindLabel(entry: ToolStripEntry): string {
  return entry.kind === 'step' ? 'Step' : 'Tool';
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

export function toolAriaLabel(entry: ToolStripEntry): string {
  return `${toolKindLabel(entry)}: ${timelineTitle(entry)} (${toolStatusLabel(entry.status)})`;
}

export function toolDetailRows(entry: ToolStripEntry): ToolDetailRow[] {
  const rows: ToolDetailRow[] = [
    { label: 'Type', value: toolKindLabel(entry) },
    { label: 'Name', value: timelineTitle(entry) },
    { label: 'Status', value: prettyLabel(toolStatusLabel(entry.status)) },
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
