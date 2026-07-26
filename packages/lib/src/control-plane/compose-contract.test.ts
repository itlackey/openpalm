/**
 * Behavioral assertions rescued from deleted text-assertion test files
 * (see bullshit-claude-wrote.md §4). These call real functions and parse real
 * config; the string-grep assertions around them were dropped.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { resolveComposeProjectName } from './docker.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

describe('assistant runs as the operator, not root', () => {
  test('core.compose.yml pins the assistant to OP_UID:OP_GID', () => {
    const compose = yamlParse(
      readFileSync(join(REPO_ROOT, 'packages/skeleton/system/stack/core.compose.yml'), 'utf8'),
    ) as { services?: Record<string, { user?: string }> };
    expect(compose.services?.assistant?.user).toBe('${OP_UID:-1000}:${OP_GID:-1000}');
  });
});

describe('resolveComposeProjectName', () => {
  const saved = process.env.OP_PROJECT_NAME;
  const restore = () => {
    if (saved === undefined) delete process.env.OP_PROJECT_NAME;
    else process.env.OP_PROJECT_NAME = saved;
  };

  test('respects OP_PROJECT_NAME', () => {
    process.env.OP_PROJECT_NAME = 'custom-project';
    try { expect(resolveComposeProjectName()).toBe('custom-project'); } finally { restore(); }
  });

  test('defaults to openpalm', () => {
    delete process.env.OP_PROJECT_NAME;
    try { expect(resolveComposeProjectName()).toBe('openpalm'); } finally { restore(); }
  });
});
