import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_LOCKED_CONNECTION_ID,
  ASSISTANT_LOCKED_CONNECTION_LABEL,
  buildLockedAssistantRuntimeConfig,
  writeUiRuntimeConfig,
  seedServedUiRuntimeConfig,
} from './ui-runtime-config.js';

describe('ui runtime config', () => {
  test('builds one locked default connection in the UI store shape (baseUrl, no kind)', () => {
    expect(buildLockedAssistantRuntimeConfig('http://127.0.0.1:3800')).toEqual({
      connections: [
        {
          id: 'openpalm-assistant-opencode',
          label: 'Local assistant',
          baseUrl: 'http://127.0.0.1:3800',
          auth: { mode: 'none' },
          isDefault: true,
          locked: true,
        },
      ],
    });
  });

  test('uses the detected project name as the connection label', () => {
    expect(buildLockedAssistantRuntimeConfig('http://127.0.0.1:3810', 'splinter').connections[0]?.label).toBe(
      'splinter',
    );
  });

  // The lib writer and the container entrypoint's inline JS writer must agree on
  // the locked-connection id/label. Exporting them as named constants lets the
  // container lane pin entrypoint.sh's literal against this value.
  test('exports the locked connection id/label as named constants matching the built connection', () => {
    expect(ASSISTANT_LOCKED_CONNECTION_ID).toBe('openpalm-assistant-opencode');
    expect(ASSISTANT_LOCKED_CONNECTION_LABEL).toBe('Local assistant');
    const built = buildLockedAssistantRuntimeConfig('http://127.0.0.1:3800').connections[0];
    expect(built.id).toBe(ASSISTANT_LOCKED_CONNECTION_ID);
    expect(built.label).toBe(ASSISTANT_LOCKED_CONNECTION_LABEL);
  });

  test('writes the runtime config JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-runtime-config-'));
    try {
      const path = join(dir, 'nested', 'runtime-config.json');
      writeUiRuntimeConfig(path, 'https://assistant.example');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
        buildLockedAssistantRuntimeConfig('https://assistant.example')
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The host serve path (Electron/CLI spawnUiChild) uses this to seed the same
  // locked default connection the container entrypoint writes — into the served
  // build's client/ static dir, where the browser store fetches
  // /runtime-config.json from the app origin.
  describe('seedServedUiRuntimeConfig', () => {
    test('writes <uiBuildDir>/client/runtime-config.json with the derived default connection', () => {
      const dir = mkdtempSync(join(tmpdir(), 'seed-ui-runtime-'));
      try {
        // empty homeDir + empty env → resolveAssistantEndpoint's derived default
        seedServedUiRuntimeConfig(dir, dir, {});
        const parsed = JSON.parse(readFileSync(join(dir, 'client', 'runtime-config.json'), 'utf8'));
        expect(parsed).toEqual(buildLockedAssistantRuntimeConfig('http://127.0.0.1:3810'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('honors the OP_UI_DEFAULT_ASSISTANT_URL override from env', () => {
      const dir = mkdtempSync(join(tmpdir(), 'seed-ui-runtime-'));
      try {
        seedServedUiRuntimeConfig(dir, dir, { OP_UI_DEFAULT_ASSISTANT_URL: 'https://assistant.example' });
        const parsed = JSON.parse(readFileSync(join(dir, 'client', 'runtime-config.json'), 'utf8'));
        expect(parsed.connections[0].baseUrl).toBe('https://assistant.example');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('uses OP_PROJECT_NAME from persisted stack config as the connection label', () => {
      const dir = mkdtempSync(join(tmpdir(), 'seed-ui-runtime-'));
      try {
        const envDir = join(dir, 'knowledge', 'env');
        mkdirSync(envDir, { recursive: true });
        writeFileSync(join(envDir, 'stack.env'), 'OP_PROJECT_NAME=splinter\n');

        seedServedUiRuntimeConfig(dir, dir, {});

        const parsed = JSON.parse(readFileSync(join(dir, 'client', 'runtime-config.json'), 'utf8'));
        expect(parsed.connections[0].label).toBe('splinter');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
