/**
 * Tests for the E1 fix: one shared resolveAssistantEndpoint(homeDir, env) used
 * by Electron/CLI/container writers instead of three divergent chains. Pins:
 *   - precedence OP_CLIENT_DEFAULT_ASSISTANT_URL || OP_OPENCODE_URL ||
 *     OP_ASSISTANT_URL || http://127.0.0.1:<port>
 *   - env (process.env) wins over the persisted stack.env/state env
 *   - wildcard bind hosts (0.0.0.0 / :: / [::]) are ALWAYS normalized to
 *     127.0.0.1 in the returned URL — this is the browser-breaking
 *     http://0.0.0.0:3800 seed bug the finding calls out.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAssistantEndpoint } from './assistant-endpoint.js';

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-assistant-endpoint-'));
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(home, 'state'), { recursive: true });
  return home;
}

function writeStackEnv(home: string, content: string): void {
  writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), content);
}

let home: string;

beforeEach(() => {
  home = makeHome();
});

describe('resolveAssistantEndpoint', () => {
  it('falls back to http://127.0.0.1:<default port> with no env/stack.env at all', () => {
    expect(resolveAssistantEndpoint(home, {})).toBe('http://127.0.0.1:3800');
  });

  it('uses OP_ASSISTANT_PORT from the persisted stack env for the fallback URL', () => {
    writeStackEnv(home, 'OP_ASSISTANT_PORT=4800\n');
    expect(resolveAssistantEndpoint(home, {})).toBe('http://127.0.0.1:4800');
  });

  it('prefers OP_ASSISTANT_URL over the port-derived fallback', () => {
    writeStackEnv(home, 'OP_ASSISTANT_PORT=4800\n');
    expect(resolveAssistantEndpoint(home, { OP_ASSISTANT_URL: 'http://example.test:9999' })).toBe(
      'http://example.test:9999'
    );
  });

  it('prefers OP_OPENCODE_URL over OP_ASSISTANT_URL', () => {
    expect(
      resolveAssistantEndpoint(home, {
        OP_OPENCODE_URL: 'http://opencode.test:1',
        OP_ASSISTANT_URL: 'http://assistant.test:2',
      })
    ).toBe('http://opencode.test:1');
  });

  it('prefers OP_CLIENT_DEFAULT_ASSISTANT_URL over everything else', () => {
    expect(
      resolveAssistantEndpoint(home, {
        OP_CLIENT_DEFAULT_ASSISTANT_URL: 'https://client-default.test',
        OP_OPENCODE_URL: 'http://opencode.test:1',
        OP_ASSISTANT_URL: 'http://assistant.test:2',
      })
    ).toBe('https://client-default.test');
  });

  it('merges process-env OVER the persisted stack env (env wins)', () => {
    writeStackEnv(home, 'OP_ASSISTANT_URL=http://from-stack-env.test:1\n');
    expect(resolveAssistantEndpoint(home, { OP_ASSISTANT_URL: 'http://from-process-env.test:2' })).toBe(
      'http://from-process-env.test:2'
    );
  });

  it('reads an override from the persisted stack env when process.env has none', () => {
    writeStackEnv(home, 'OP_OPENCODE_URL=http://from-stack-env.test:3800\n');
    expect(resolveAssistantEndpoint(home, {})).toBe('http://from-stack-env.test:3800');
  });

  it('normalizes a wildcard 0.0.0.0 fallback host to 127.0.0.1 (the E1 seed bug)', () => {
    // This is the exact shape the pre-fix Electron chain produced: bind
    // address 0.0.0.0 (from the admin LAN-exposure toggle) baked directly
    // into the seeded default connection URL — browsers can't fetch it.
    writeStackEnv(home, 'OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\nOP_ASSISTANT_PORT=3800\n');
    const result = resolveAssistantEndpoint(home, {});
    expect(result).toBe('http://127.0.0.1:3800');
    expect(result).not.toContain('0.0.0.0');
  });

  it('normalizes a wildcard host in an explicit OP_ASSISTANT_URL override', () => {
    expect(resolveAssistantEndpoint(home, { OP_ASSISTANT_URL: 'http://0.0.0.0:3800' })).toBe(
      'http://127.0.0.1:3800'
    );
  });

  it('normalizes the IPv6 wildcard form [::] in an override', () => {
    expect(resolveAssistantEndpoint(home, { OP_OPENCODE_URL: 'http://[::]:3800' })).toBe(
      'http://127.0.0.1:3800'
    );
    expect(resolveAssistantEndpoint(home, { OP_CLIENT_DEFAULT_ASSISTANT_URL: 'http://[::]/chat' })).toBe(
      'http://127.0.0.1/chat'
    );
  });

  it('honors a specific non-wildcard OP_ASSISTANT_BIND_ADDRESS in the fallback URL (E1 follow-up)', () => {
    // A concrete LAN IP (as opposed to a wildcard 0.0.0.0/::) is something
    // docker publishes the assistant port ONLY on — 127.0.0.1 is not
    // reachable in that configuration, so the fallback must preserve it
    // instead of collapsing to loopback.
    writeStackEnv(home, 'OP_ASSISTANT_BIND_ADDRESS=192.168.1.50\nOP_ASSISTANT_PORT=3800\n');
    expect(resolveAssistantEndpoint(home, {})).toBe('http://192.168.1.50:3800');
  });

  it('still normalizes wildcard bind hosts to 127.0.0.1 even though specific hosts are preserved', () => {
    writeStackEnv(home, 'OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\nOP_ASSISTANT_PORT=3800\n');
    expect(resolveAssistantEndpoint(home, {})).toBe('http://127.0.0.1:3800');
    writeStackEnv(home, 'OP_ASSISTANT_BIND_ADDRESS=::\nOP_ASSISTANT_PORT=3800\n');
    expect(resolveAssistantEndpoint(home, {})).toBe('http://127.0.0.1:3800');
  });

  it('an explicit override still wins over a specific OP_ASSISTANT_BIND_ADDRESS', () => {
    writeStackEnv(home, 'OP_ASSISTANT_BIND_ADDRESS=192.168.1.50\n');
    expect(
      resolveAssistantEndpoint(home, { OP_ASSISTANT_URL: 'http://example.test:9999' })
    ).toBe('http://example.test:9999');
  });

  it('an unset or loopback OP_ASSISTANT_BIND_ADDRESS falls back to 127.0.0.1 as before', () => {
    expect(resolveAssistantEndpoint(home, {})).toBe('http://127.0.0.1:3800');
    writeStackEnv(home, 'OP_ASSISTANT_BIND_ADDRESS=127.0.0.1\nOP_ASSISTANT_PORT=3800\n');
    expect(resolveAssistantEndpoint(home, {})).toBe('http://127.0.0.1:3800');
  });

  it('defaults env to process.env when omitted', () => {
    const prior = process.env.OP_ASSISTANT_URL;
    process.env.OP_ASSISTANT_URL = 'http://from-process-global.test:1';
    try {
      expect(resolveAssistantEndpoint(home)).toBe('http://from-process-global.test:1');
    } finally {
      if (prior === undefined) delete process.env.OP_ASSISTANT_URL;
      else process.env.OP_ASSISTANT_URL = prior;
    }
  });
});
