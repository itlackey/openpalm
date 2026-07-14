import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_LOCKED_CONNECTION_ID,
  ASSISTANT_LOCKED_CONNECTION_LABEL,
  buildLockedAssistantRuntimeConfig,
  writeClientRuntimeConfig,
} from './client-runtime-config.js';

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

  // A2/H4 enabler: an optional hostUrl lets the client SPA render a "Manage
  // assistant" / "Open OpenPalm admin" link back to the host UI (3880) — the
  // escape hatch A2 and H4 need. Existing 2-arg callers must keep compiling
  // and keep writing no hostUrl field at all (backward compatible).
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

  // #486 D1a: a null assistant URL is the stack-less client-only serve — the
  // CLI-written runtime-config.json must not seed the locked "This assistant"
  // connection pointing at a dead http://127.0.0.1:3800, or the client's
  // landing resolver counts 1 stored connection and lands on /chat against a
  // dead target instead of /connections/new.
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
});
