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
