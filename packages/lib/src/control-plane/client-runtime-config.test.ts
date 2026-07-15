import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_LOCKED_CONNECTION_ID,
  ASSISTANT_LOCKED_CONNECTION_LABEL,
  buildLockedAssistantRuntimeConfig,
  writeClientRuntimeConfig,
  seedServedUiRuntimeConfig,
} from './client-runtime-config.js';

describe('client runtime config', () => {
  test('builds one locked default connection in the UI store shape (baseUrl, no kind)', () => {
    expect(buildLockedAssistantRuntimeConfig('http://127.0.0.1:3800')).toEqual({
      connections: [
        {
          id: 'openpalm-assistant-opencode',
          label: 'This assistant',
          baseUrl: 'http://127.0.0.1:3800',
          auth: { mode: 'none' },
          isDefault: true,
          locked: true,
        },
      ],
    });
  });

  // I5: the lib writer and the container entrypoint's inline JS writer must
  // agree on the locked-connection id/label. Exporting them as named
  // constants lets the container lane pin entrypoint.sh's literal against
  // this value instead of letting the two copies drift silently.
  test('exports the locked connection id/label as named constants matching the built connection', () => {
    expect(ASSISTANT_LOCKED_CONNECTION_ID).toBe('openpalm-assistant-opencode');
    expect(ASSISTANT_LOCKED_CONNECTION_LABEL).toBe('This assistant');
    const built = buildLockedAssistantRuntimeConfig('http://127.0.0.1:3800').connections[0];
    expect(built.id).toBe(ASSISTANT_LOCKED_CONNECTION_ID);
    expect(built.label).toBe(ASSISTANT_LOCKED_CONNECTION_LABEL);
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

  // The writer still supports an optional hostUrl field (a loopback link to the
  // host admin surface). It is inert in the one-UI store today — the served UI
  // owns /host on its own origin — but the field stays supported and backward
  // compatible: 2-arg callers keep compiling and write no hostUrl at all.
  test('writes an optional hostUrl alongside the connections when provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-runtime-config-'));
    try {
      const path = join(dir, 'runtime-config.json');
      writeClientRuntimeConfig(path, 'http://127.0.0.1:3800', { hostUrl: 'http://127.0.0.1:3880/host' });
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      expect(parsed.hostUrl).toBe('http://127.0.0.1:3880/host');
      expect(parsed.connections).toEqual(buildLockedAssistantRuntimeConfig('http://127.0.0.1:3800').connections);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('omits hostUrl entirely when not provided (existing 2-arg callers unaffected)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-runtime-config-'));
    try {
      const path = join(dir, 'runtime-config.json');
      writeClientRuntimeConfig(path, 'http://127.0.0.1:3800');
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      expect('hostUrl' in parsed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A null assistant URL writes connections: [] instead of the locked "This
  // assistant" entry — the writer's contract for a serve with no known assistant
  // to seed. The store's seedFromRuntimeConfig prunes a previously-seeded locked
  // entry absent from the new config, so this round-trips cleanly.
  test('writeClientRuntimeConfig(path, null) writes connections: [] and still honors hostUrl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-runtime-config-'));
    try {
      const path = join(dir, 'runtime-config.json');
      writeClientRuntimeConfig(path, null, { hostUrl: 'http://127.0.0.1:3880/host' });
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      expect(parsed.connections).toEqual([]);
      expect(parsed.hostUrl).toBe('http://127.0.0.1:3880/host');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writeClientRuntimeConfig(path, null) omits hostUrl when not passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-runtime-config-'));
    try {
      const path = join(dir, 'runtime-config.json');
      writeClientRuntimeConfig(path, null);
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      expect(parsed.connections).toEqual([]);
      expect('hostUrl' in parsed).toBe(false);
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
        expect(parsed).toEqual(buildLockedAssistantRuntimeConfig('http://127.0.0.1:3800'));
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
  });
});
