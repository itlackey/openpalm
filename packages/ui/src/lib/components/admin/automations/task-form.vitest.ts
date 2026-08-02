/**
 * Unit tests for task-form helpers:
 *   - cron → preset reverse mapping
 *   - raw YAML preservation
 *   - canonical .yml filename validation
 */
import { describe, expect, test } from 'vitest';
import {
  cronToPresetId,
  newFormData,
  validateTaskFilename,
  yamlToFormData,
} from './task-form.js';

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

// ── validateTaskFilename ──────────────────────────────────────────────────

describe('validateTaskFilename', () => {
  test('accepts valid names', () => {
    expect(validateTaskFilename('my-task.yml')).toBeNull();
    expect(validateTaskFilename('backup_daily.yml')).toBeNull();
    expect(validateTaskFilename('My.Task..v2.yml')).toBeNull();
  });

  test('rejects empty name', () => {
    expect(validateTaskFilename('')).not.toBeNull();
    expect(validateTaskFilename('   ')).not.toBeNull();
  });

  test('rejects path separators', () => {
    expect(validateTaskFilename('../escape.yml')).not.toBeNull();
    expect(validateTaskFilename('a/b.yml')).not.toBeNull();
  });

  test('rejects wrong extensions', () => {
    expect(validateTaskFilename('task.txt')).not.toBeNull();
    expect(validateTaskFilename('task.json')).not.toBeNull();
    expect(validateTaskFilename('task.yaml')).not.toBeNull();
    expect(validateTaskFilename('task.md')).not.toBeNull();
    expect(validateTaskFilename('task.yml.yml')).not.toBeNull();
    expect(validateTaskFilename('task.yaml.yml')).not.toBeNull();
  });
});

describe('raw YAML editor state', () => {
  test('preserves existing task bytes exactly', () => {
    const rawYaml = `# keep this comment
version: 2
schedule: "0 9 * * *"
tags: [maintenance]
timeoutMs: 30000
command: ["sh", "-c", "printf '%s\\n' hello"]
`;
    expect(yamlToFormData('my-task.yml', rawYaml)).toEqual({
      fileName: 'my-task.yml',
      rawYaml,
    });
  });
});

// ── newFormData defaults ──────────────────────────────────────────────────

describe('newFormData', () => {
  test('starts with a valid disabled AKM v2 command task', () => {
    const form = newFormData();
    expect(form.fileName).toBe('');
    expect(form.rawYaml).toContain('version: 2');
    expect(form.rawYaml).toContain('schedule: "0 9 * * *"');
    expect(form.rawYaml).toContain('enabled: false');
    expect(form.rawYaml).toContain('command:');
  });
});
