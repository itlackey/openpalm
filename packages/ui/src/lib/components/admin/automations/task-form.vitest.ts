/**
 * Unit tests for task-form helpers:
 *   - raw YAML editor initialization
 *   - pinned AKM .yml filename validation
 */
import { describe, expect, test } from 'vitest';
import { newFormData, validateTaskFilename, yamlToFormData } from './task-form.js';

// ── validateTaskFilename ──────────────────────────────────────────────────

describe('validateTaskFilename', () => {
  test('accepts filenames matching the pinned AKM task ID contract', () => {
    expect(validateTaskFilename('my-task.yml')).toBeNull();
    expect(validateTaskFilename('backup_daily.yml')).toBeNull();
    expect(validateTaskFilename('My.Task..v2.yml')).toBeNull();
    expect(validateTaskFilename(`${'a'.repeat(228)}.yml`)).toBeNull();
    expect(validateTaskFilename('foo..yml')).toBeNull();
  });

  test('rejects empty name', () => {
    expect(validateTaskFilename('')).not.toBeNull();
    expect(validateTaskFilename('   ')).not.toBeNull();
  });

  test('rejects path separators', () => {
    expect(validateTaskFilename('../escape.yml')).not.toBeNull();
    expect(validateTaskFilename('a/b.yml')).not.toBeNull();
    expect(validateTaskFilename('a\\b.yml')).not.toBeNull();
  });

  test('rejects names whose task ID is normalized or unsafe', () => {
    for (const name of [
      'foo .yml',
      '.yml',
      '..yml',
      '...yml',
      'not an akm id.yml',
      'task.yml.yml',
      'task.yaml.yml',
      'café.yml',
      'CON.yml',
      'bad:name.yml',
      'line\nbreak.yml',
      `${'a'.repeat(229)}.yml`,
    ]) {
      expect(validateTaskFilename(name)).not.toBeNull();
    }
  });

  test('rejects non-canonical suffixes', () => {
    expect(validateTaskFilename('task.txt')).not.toBeNull();
    expect(validateTaskFilename('task.json')).not.toBeNull();
    expect(validateTaskFilename('task.yaml')).not.toBeNull();
    expect(validateTaskFilename('task.md')).not.toBeNull();
    expect(validateTaskFilename('task.YML')).not.toBeNull();
  });
});

describe('raw YAML editor state', () => {
  test('initializes the editor without parsing or reformatting', () => {
    const rawYaml = `# keep this comment
version: 2
schedule: "0 9 * * *"
tags: [maintenance]
timeoutMs: 30000
command: ["sh", "-c", "printf '%s\\n' hello"]
`;
    expect(yamlToFormData('my-task.yml', rawYaml, 'sha256:revision')).toEqual({
      fileName: 'my-task.yml',
      rawYaml,
      revision: 'sha256:revision',
    });
  });
});

// ── newFormData defaults ──────────────────────────────────────────────────

describe('newFormData', () => {
  test('starts with a valid disabled AKM v2 command task', () => {
    const form = newFormData();
    expect(form.fileName).toBe('');
    expect(form.revision).toBeNull();
    expect(form.rawYaml).toContain('version: 2');
    expect(form.rawYaml).toContain('schedule: "0 9 * * *"');
    expect(form.rawYaml).toContain('enabled: false');
    expect(form.rawYaml).toContain('command:');
  });
});
