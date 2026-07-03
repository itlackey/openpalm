/**
 * Schedule presets and YAML round-trip helpers for the task drawer form.
 *
 * Round-trip contract: unknown YAML keys in a task file are preserved because
 * we parse the full YAML document, update only known fields, and re-stringify
 * the entire document (including unknown keys).
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ── Schedule presets ──────────────────────────────────────────────────────

export type SchedulePresetId =
  | 'every-15-minutes'
  | 'every-hour'
  | 'daily'
  | 'daily-custom'
  | 'weekly'
  | 'weekly-custom'
  | 'monthly'
  | 'monthly-custom'
  | 'advanced';

export interface SchedulePreset {
  id: SchedulePresetId;
  label: string;
  /** null = requires extra parameters (time / day) */
  cron: string | null;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: 'every-15-minutes', label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { id: 'every-hour',       label: 'Every hour',       cron: '0 * * * *' },
  { id: 'daily',            label: 'Daily at…',        cron: null },
  { id: 'weekly',           label: 'Weekly on…',       cron: null },
  { id: 'monthly',          label: 'Monthly on day…',  cron: null },
  { id: 'advanced',         label: 'Advanced (cron)',  cron: null },
];

/** Map a cron expression to the best-matching preset id, or 'advanced'. */
export function cronToPresetId(cron: string): SchedulePresetId {
  const trimmed = cron.trim();
  // Fixed presets first
  if (trimmed === '*/15 * * * *') return 'every-15-minutes';
  if (trimmed === '0 * * * *')    return 'every-hour';
  // Daily: `0 <H> * * *`
  if (/^0 \d{1,2} \* \* \*$/.test(trimmed)) return 'daily';
  // Weekly: `0 <H> * * <DOW>` where DOW is 0-6
  if (/^0 \d{1,2} \* \* [0-6]$/.test(trimmed)) return 'weekly';
  // Monthly: `0 <H> <DOM> * *` where DOM is 1-31
  if (/^0 \d{1,2} ([1-9]|[12]\d|3[01]) \* \*$/.test(trimmed)) return 'monthly';
  return 'advanced';
}

/** Extract hour (0-23) from a cron expression, falling back to 0. */
export function cronToHour(cron: string): number {
  const m = cron.trim().match(/^0 (\d{1,2})/);
  const h = m ? parseInt(m[1] ?? '0', 10) : 0;
  return Number.isNaN(h) ? 0 : Math.min(23, Math.max(0, h));
}

/** Extract day-of-week (0-6) from a weekly cron expression. */
export function cronToDow(cron: string): number {
  const m = cron.trim().match(/^0 \d{1,2} \* \* (\d)$/);
  const d = m ? parseInt(m[1] ?? '0', 10) : 0;
  return Number.isNaN(d) ? 0 : Math.min(6, Math.max(0, d));
}

/** Extract day-of-month (1-31) from a monthly cron expression. */
export function cronToDom(cron: string): number {
  const m = cron.trim().match(/^0 \d{1,2} (\d{1,2}) \* \*$/);
  const d = m ? parseInt(m[1] ?? '1', 10) : 1;
  return Number.isNaN(d) ? 1 : Math.min(31, Math.max(1, d));
}

/** Build a cron string from preset parameters. */
export function buildCron(
  presetId: SchedulePresetId,
  hour: number,
  dow: number,
  dom: number,
  rawCron: string
): string {
  switch (presetId) {
    case 'every-15-minutes': return '*/15 * * * *';
    case 'every-hour':       return '0 * * * *';
    case 'daily':            return `0 ${hour} * * *`;
    case 'weekly':           return `0 ${hour} * * ${dow}`;
    case 'monthly':          return `0 ${hour} ${dom} * *`;
    default:                 return rawCron;
  }
}

export const DOW_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/** Human-readable summary of the resolved cron expression. */
export function describeCron(
  presetId: SchedulePresetId,
  hour: number,
  dow: number,
  dom: number,
  rawCron: string
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const timeStr = `${pad(hour)}:00`;
  switch (presetId) {
    case 'every-15-minutes': return 'Runs every 15 minutes';
    case 'every-hour':       return 'Runs at the start of every hour';
    case 'daily':            return `Runs daily at ${timeStr}`;
    case 'weekly':           return `Runs every ${DOW_LABELS[dow] ?? 'Sunday'} at ${timeStr}`;
    case 'monthly':          return `Runs on day ${dom} of every month at ${timeStr}`;
    case 'advanced': {
      if (!rawCron.trim()) return 'Enter a valid cron expression';
      const err = validateCron(rawCron);
      return err ? err : `Runs on schedule: ${rawCron.trim()}`;
    }
    default: return '';
  }
}

/** Returns an error message or null if valid. */
export function validateCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'Must have exactly 5 fields: minute hour day month weekday';
  const ranges = [
    [0, 59],   // minute
    [0, 23],   // hour
    [1, 31],   // day-of-month
    [1, 12],   // month
    [0, 7],    // day-of-week (0 and 7 are both Sunday)
  ] as const;
  for (const [i, field] of parts.entries()) {
    if (field === '*' || /^\*\/\d+$/.test(field)) continue;
    const n = parseInt(field, 10);
    if (Number.isNaN(n)) return `Field ${i + 1} is not a valid number or wildcard`;
    // biome-ignore lint/style/noNonNullAssertion: parts.length === 5 checked above and ranges is a fixed 5-element tuple, so ranges[i] is defined for every i.
    const [min, max] = ranges[i]!;
    if (n < min || n > max) return `Field ${i + 1} must be ${min}–${max}`;
  }
  return null;
}

// ── File-name validation ───────────────────────────────────────────────────

/** Returns an error message or null if valid. */
export function validateTaskFilename(name: string): string | null {
  if (!name.trim()) return 'File name is required';
  if (!/^[a-z0-9][a-z0-9_-]*\.(yml|yaml|md)$/.test(name.trim())) {
    return 'Use lowercase letters, digits, hyphens, and underscores. Must end in .yml, .yaml, or .md';
  }
  return null;
}

// ── YAML round-trip ────────────────────────────────────────────────────────

export interface TaskFormData {
  /** Original filename (empty string for new tasks) */
  fileName: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Resolved cron expression */
  schedule: string;
  /** The kind of action: 'command' | 'prompt' | 'workflow' */
  actionKind: 'command' | 'prompt' | 'workflow';
  /** Shell command as a single string (joined from command array) */
  commandShell: string;
  /** Prompt text for assistant tasks */
  promptBody: string;
  /** Workflow ref for workflow tasks */
  workflowRef: string;
  /** Unparsed original YAML string (used to detect unknown keys) */
  rawYaml: string;
  /** Any unknown top-level keys from the original YAML doc, preserved verbatim */
  unknownKeys: Record<string, unknown>;
}

/** Parse a task YAML string into form data, preserving unknown keys. */
export function yamlToFormData(fileName: string, content: string): TaskFormData {
  let doc: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    // Silently fall through to defaults for unparseable YAML
  }

  const knownKeys = new Set([
    'schedule', 'enabled', 'description', 'tags', 'timeoutMs',
    'command', 'prompt', 'profile', 'workflow', 'params',
    'on_failure', 'timezone',
  ]);
  const unknownKeys: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!knownKeys.has(k)) unknownKeys[k] = v;
  }

  const schedule = typeof doc.schedule === 'string' ? doc.schedule.trim() : '0 9 * * *';

  let actionKind: 'command' | 'prompt' | 'workflow' = 'command';
  let commandShell = 'echo hello';
  let promptBody = '';
  let workflowRef = '';

  if (doc.command !== undefined) {
    actionKind = 'command';
    const cmd = Array.isArray(doc.command)
      ? doc.command.map(String)
      : typeof doc.command === 'string'
        ? [doc.command]
        : ['echo', 'hello'];
    commandShell = cmd.join(' ');
  } else if (doc.prompt !== undefined) {
    actionKind = 'prompt';
    promptBody = typeof doc.prompt === 'string' ? doc.prompt : '';
  } else if (doc.workflow !== undefined) {
    actionKind = 'workflow';
    workflowRef = typeof doc.workflow === 'string' ? doc.workflow : '';
  }

  const name = fileName.replace(/\.(yml|yaml|md)$/, '');

  return {
    fileName,
    name,
    description: typeof doc.description === 'string' ? doc.description : '',
    enabled: doc.enabled !== false,
    schedule,
    actionKind,
    commandShell,
    promptBody,
    workflowRef,
    rawYaml: content,
    unknownKeys,
  };
}

/** Serialize form data back to a YAML string, preserving unknown keys. */
export function formDataToYaml(form: TaskFormData): string {
  const doc: Record<string, unknown> = {
    schedule: form.schedule,
    enabled: form.enabled,
  };
  if (form.description.trim()) {
    doc.description = form.description.trim();
  }

  if (form.actionKind === 'command') {
    // Store as sh -c <shell> so it's a proper argv array
    const trimmed = form.commandShell.trim();
    doc.command = trimmed ? ['sh', '-c', trimmed] : ['sh', '-c', 'echo hello'];
  } else if (form.actionKind === 'prompt') {
    doc.prompt = form.promptBody.trim() || 'inline';
  } else {
    doc.workflow = form.workflowRef.trim();
  }

  // Re-attach any unknown keys the user had in the original file
  for (const [k, v] of Object.entries(form.unknownKeys)) {
    doc[k] = v;
  }

  return stringifyYaml(doc, { lineWidth: 0 });
}

/** Create default form data for a new task. */
export function newFormData(): TaskFormData {
  return {
    fileName: '',
    name: '',
    description: '',
    enabled: false,
    schedule: '0 9 * * *',
    actionKind: 'command',
    commandShell: 'echo hello',
    promptBody: '',
    workflowRef: '',
    rawYaml: '',
    unknownKeys: {},
  };
}
