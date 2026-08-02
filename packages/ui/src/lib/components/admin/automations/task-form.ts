/** Schedule display helpers and raw AKM v2 task editor state. */

// ── Schedule presets ──────────────────────────────────────────────────────

export type SchedulePresetId =
  | 'every-15-minutes'
  | 'every-hour'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'advanced';

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

// ── File-name validation ───────────────────────────────────────────────────

/** Returns an error message or null if valid. */
export function validateTaskFilename(name: string): string | null {
  if (!name.trim()) return 'File name is required';
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.yml$/.test(trimmed) || /\.ya?ml\.yml$/i.test(trimmed)) {
    return 'Use letters, digits, dots, hyphens, and underscores. Must end in .yml';
  }
  return null;
}

export interface TaskFormData {
  fileName: string;
  rawYaml: string;
}

/** Preserve existing task bytes exactly; the server syntax-checks YAML on save. */
export function yamlToFormData(fileName: string, content: string): TaskFormData {
  return { fileName, rawYaml: content };
}

/** Create default form data for a new task. */
export function newFormData(): TaskFormData {
  return {
    fileName: '',
    rawYaml: `version: 2
schedule: "0 9 * * *"
enabled: false
command:
  - /bin/sh
  - -c
  - echo hello
`,
  };
}
