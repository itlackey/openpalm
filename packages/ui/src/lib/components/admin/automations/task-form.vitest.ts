/**
 * Unit tests for task-form helpers:
 *   - preset → cron generation
 *   - cron → preset reverse mapping
 *   - unknown-YAML-key preservation on edit round-trip
 *   - cron validation rejects bad expressions
 */
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  buildCron,
  cronToPresetId,
  describeCron,
  formDataToYaml,
  newFormData,
  validateCron,
  validateTaskFilename,
  yamlToFormData,
} from './task-form.js';

// ── preset → cron ────────────────────────────────────────────────────────

describe('buildCron', () => {
  test('every-15-minutes ignores extra params', () => {
    expect(buildCron('every-15-minutes', 9, 1, 15, '')).toBe('*/15 * * * *');
  });

  test('every-hour ignores extra params', () => {
    expect(buildCron('every-hour', 9, 1, 15, '')).toBe('0 * * * *');
  });

  test('daily uses hour param', () => {
    expect(buildCron('daily', 8, 0, 1, '')).toBe('0 8 * * *');
    expect(buildCron('daily', 0, 0, 1, '')).toBe('0 0 * * *');
    expect(buildCron('daily', 23, 0, 1, '')).toBe('0 23 * * *');
  });

  test('weekly uses hour and dow params', () => {
    expect(buildCron('weekly', 3, 0, 1, '')).toBe('0 3 * * 0');
    expect(buildCron('weekly', 8, 5, 1, '')).toBe('0 8 * * 5');
  });

  test('monthly uses hour and dom params', () => {
    expect(buildCron('monthly', 4, 0, 1, '')).toBe('0 4 1 * *');
    expect(buildCron('monthly', 9, 0, 15, '')).toBe('0 9 15 * *');
  });

  test('advanced passes rawCron through', () => {
    expect(buildCron('advanced', 0, 0, 0, '5 4 * * 1')).toBe('5 4 * * 1');
    expect(buildCron('advanced', 0, 0, 0, '')).toBe('');
  });
});

// ── cron → preset reverse mapping ────────────────────────────────────────

describe('cronToPresetId', () => {
  test('maps known fixed presets', () => {
    expect(cronToPresetId('*/15 * * * *')).toBe('every-15-minutes');
    expect(cronToPresetId('0 * * * *')).toBe('every-hour');
  });

  test('recognises daily variants', () => {
    expect(cronToPresetId('0 0 * * *')).toBe('daily');
    expect(cronToPresetId('0 8 * * *')).toBe('daily');
    expect(cronToPresetId('0 9 * * *')).toBe('daily');
    expect(cronToPresetId('0 23 * * *')).toBe('daily');
  });

  test('recognises weekly variants', () => {
    expect(cronToPresetId('0 3 * * 0')).toBe('weekly');
    expect(cronToPresetId('0 8 * * 5')).toBe('weekly');
  });

  test('recognises monthly variants', () => {
    expect(cronToPresetId('0 4 1 * *')).toBe('monthly');
    expect(cronToPresetId('0 9 15 * *')).toBe('monthly');
  });

  test('falls back to advanced for non-matching expressions', () => {
    expect(cronToPresetId('5 4 * * 1')).toBe('advanced');
    expect(cronToPresetId('*/5 * * * *')).toBe('advanced');
    expect(cronToPresetId('* * * * *')).toBe('advanced');
    expect(cronToPresetId('0 0 0 * *')).toBe('advanced');
  });

  test('trims whitespace', () => {
    expect(cronToPresetId('  */15 * * * *  ')).toBe('every-15-minutes');
  });
});

// ── describeCron ──────────────────────────────────────────────────────────

describe('describeCron', () => {
  test('fixed presets produce readable summaries', () => {
    expect(describeCron('every-15-minutes', 0, 0, 1, '')).toBe('Runs every 15 minutes');
    expect(describeCron('every-hour', 0, 0, 1, '')).toBe('Runs at the start of every hour');
  });

  test('daily summary includes time', () => {
    expect(describeCron('daily', 9, 0, 1, '')).toBe('Runs daily at 09:00');
  });

  test('weekly summary includes day and time', () => {
    expect(describeCron('weekly', 3, 0, 1, '')).toBe('Runs every Sunday at 03:00');
    expect(describeCron('weekly', 8, 5, 1, '')).toBe('Runs every Friday at 08:00');
  });

  test('monthly summary includes day and time', () => {
    expect(describeCron('monthly', 4, 0, 1, '')).toBe('Runs on day 1 of every month at 04:00');
  });
});

// ── validateCron ──────────────────────────────────────────────────────────

describe('validateCron', () => {
  test('accepts valid 5-field expressions', () => {
    expect(validateCron('* * * * *')).toBeNull();
    expect(validateCron('*/15 * * * *')).toBeNull();
    expect(validateCron('0 8 * * *')).toBeNull();
    expect(validateCron('0 0 1 1 0')).toBeNull();
    expect(validateCron('59 23 31 12 7')).toBeNull();
  });

  test('rejects wrong field count', () => {
    expect(validateCron('')).not.toBeNull();
    expect(validateCron('* * * *')).not.toBeNull();
    expect(validateCron('* * * * * *')).not.toBeNull();
  });

  test('rejects out-of-range values', () => {
    expect(validateCron('60 * * * *')).not.toBeNull();  // minute > 59
    expect(validateCron('* 24 * * *')).not.toBeNull();  // hour > 23
    expect(validateCron('* * 0 * *')).not.toBeNull();   // dom < 1
    expect(validateCron('* * 32 * *')).not.toBeNull();  // dom > 31
    expect(validateCron('* * * 0 *')).not.toBeNull();   // month < 1
    expect(validateCron('* * * 13 *')).not.toBeNull();  // month > 12
    expect(validateCron('* * * * 8')).not.toBeNull();   // dow > 7
  });

  test('rejects non-numeric non-wildcard fields', () => {
    expect(validateCron('abc * * * *')).not.toBeNull();
  });
});

// ── validateTaskFilename ──────────────────────────────────────────────────

describe('validateTaskFilename', () => {
  test('accepts valid names', () => {
    expect(validateTaskFilename('my-task.yml')).toBeNull();
    expect(validateTaskFilename('backup_daily.yaml')).toBeNull();
    expect(validateTaskFilename('task1.md')).toBeNull();
  });

  test('rejects empty name', () => {
    expect(validateTaskFilename('')).not.toBeNull();
    expect(validateTaskFilename('   ')).not.toBeNull();
  });

  test('rejects uppercase', () => {
    expect(validateTaskFilename('MyTask.yml')).not.toBeNull();
  });

  test('rejects path separators', () => {
    expect(validateTaskFilename('../escape.yml')).not.toBeNull();
    expect(validateTaskFilename('a/b.yml')).not.toBeNull();
  });

  test('rejects wrong extensions', () => {
    expect(validateTaskFilename('task.txt')).not.toBeNull();
    expect(validateTaskFilename('task.json')).not.toBeNull();
  });
});

// ── unknown-YAML-key preservation on round-trip ──────────────────────────

describe('YAML round-trip preserves unknown keys', () => {
  const rawYaml = [
    "schedule: '0 9 * * *'",
    'enabled: true',
    'description: Daily hello',
    'command:',
    '  - sh',
    '  - -c',
    '  - echo hello',
    'tags:',
    '  - maintenance',
    'timeoutMs: 30000',
    'my_custom_key: some value',
    'another_custom: 42',
  ].join('\n');

  test('parses custom fields into unknownKeys', () => {
    const form = yamlToFormData('my-task.yml', rawYaml);
    expect(form.unknownKeys).toHaveProperty('my_custom_key', 'some value');
    expect(form.unknownKeys).toHaveProperty('another_custom', 42);
  });

  test('known fields are NOT in unknownKeys', () => {
    const form = yamlToFormData('my-task.yml', rawYaml);
    expect(form.unknownKeys).not.toHaveProperty('schedule');
    expect(form.unknownKeys).not.toHaveProperty('command');
    expect(form.unknownKeys).not.toHaveProperty('enabled');
    expect(form.unknownKeys).not.toHaveProperty('tags');
    expect(form.unknownKeys).not.toHaveProperty('timeoutMs');
  });

  test('formDataToYaml re-emits unknown keys', () => {
    const form = yamlToFormData('my-task.yml', rawYaml);
    const out = formDataToYaml(form);
    const doc = parseYaml(out) as Record<string, unknown>;
    expect(doc).toHaveProperty('my_custom_key', 'some value');
    expect(doc).toHaveProperty('another_custom', 42);
  });

  test('edit round-trip preserves unknown keys end-to-end', () => {
    const form = yamlToFormData('my-task.yml', rawYaml);
    // Simulate user editing description and enabled
    form.description = 'Updated description';
    form.enabled = false;
    const out = formDataToYaml(form);

    const doc = parseYaml(out) as Record<string, unknown>;
    expect(doc).toHaveProperty('my_custom_key', 'some value');
    expect(doc).toHaveProperty('another_custom', 42);
    expect(doc.description).toBe('Updated description');
    expect(doc.enabled).toBe(false);
  });
});

// ── newFormData defaults ──────────────────────────────────────────────────

describe('newFormData', () => {
  test('has sensible defaults', () => {
    const form = newFormData();
    expect(form.enabled).toBe(false);
    expect(form.schedule).toBe('0 9 * * *');
    expect(form.actionKind).toBe('command');
    expect(form.fileName).toBe('');
    expect(form.unknownKeys).toEqual({});
  });
});
