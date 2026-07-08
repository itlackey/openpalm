import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLockedAssistantRuntimeConfig, writeClientRuntimeConfig } from './client-runtime-config.js';

describe('client runtime config', () => {
  test('builds one locked default local-opencode connection', () => {
    expect(buildLockedAssistantRuntimeConfig('http://127.0.0.1:3800')).toEqual({
      connections: [
        {
          id: 'openpalm-assistant-opencode',
          label: 'This assistant',
          kind: 'local-opencode',
          url: 'http://127.0.0.1:3800',
          auth: { mode: 'none' },
          isDefault: true,
          locked: true,
        },
      ],
    });
  });

  test('writes the runtime config JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-runtime-config-'));
    try {
      const path = join(dir, 'nested', 'runtime-config.json');
      writeClientRuntimeConfig(path, 'https://assistant.example');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
        buildLockedAssistantRuntimeConfig('https://assistant.example')
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
