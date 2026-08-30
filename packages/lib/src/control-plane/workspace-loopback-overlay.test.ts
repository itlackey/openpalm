/**
 * The workspace loopback overlay: OpenCode's web UI stays reachable at
 * 127.0.0.1 when the UI is bound to a concrete LAN address.
 *
 * core.compose.yml publishes the workspace on the UI's own interface, which
 * covers loopback for the default (127.0.0.1) and the wildcard (0.0.0.0) but
 * not for a specific address — leaving the desktop window, whose page is on
 * localhost, framing a port nothing answers. The overlay adds a second publish
 * rather than moving the first, because the workspace is authenticated by the
 * session cookie and cookies are scoped by host, not port: the LAN publish has
 * to stay exactly as it is for LAN browsers.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { needsWorkspaceLoopbackPublish } from './bind-warning.js';
import { discoverStackOverlays } from './config-persistence.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const STACK_DIR = join(REPO_ROOT, 'packages/skeleton/system/stack');
const OVERLAY = 'workspace.compose.loopback.yml';

describe('needsWorkspaceLoopbackPublish', () => {
  test('a concrete address needs the extra publish — nothing else answers loopback', () => {
    expect(needsWorkspaceLoopbackPublish('192.168.0.201')).toBe(true);
    expect(needsWorkspaceLoopbackPublish('10.0.0.5')).toBe(true);
    expect(needsWorkspaceLoopbackPublish('fd7a:115c:a1e0::1')).toBe(true);
  });

  test('loopback and wildcard already answer 127.0.0.1, so they do not', () => {
    for (const v of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::']) {
      expect(needsWorkspaceLoopbackPublish(v)).toBe(false);
    }
  });

  test('unset falls back to the compose default (127.0.0.1) and needs nothing', () => {
    expect(needsWorkspaceLoopbackPublish(undefined)).toBe(false);
    expect(needsWorkspaceLoopbackPublish('')).toBe(false);
    expect(needsWorkspaceLoopbackPublish('   ')).toBe(false);
  });
});

describe('the shipped overlay', () => {
  test('publishes the workspace port on 127.0.0.1 for the assistant', () => {
    const doc = yamlParse(readFileSync(join(STACK_DIR, OVERLAY), 'utf8')) as {
      services?: Record<string, { ports?: string[] }>;
    };
    const ports = doc.services?.assistant?.ports ?? [];
    expect(ports).toHaveLength(1);
    expect(ports[0]).toContain('127.0.0.1:');
    // Host and container port are the same value, matching core.compose.yml —
    // the advertised address must be the one that is bound.
    expect(ports[0]).toBe('127.0.0.1:${OP_WORKSPACE_PORT:-3820}:${OP_WORKSPACE_PORT:-3820}');
  });

  test('touches nothing but the assistant ports', () => {
    const doc = yamlParse(readFileSync(join(STACK_DIR, OVERLAY), 'utf8')) as {
      services?: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(doc.services ?? {})).toEqual(['assistant']);
    expect(Object.keys(doc.services?.assistant ?? {})).toEqual(['ports']);
  });
});

describe('discoverStackOverlays includes it only for a concrete bind', () => {
  /** A home with the managed stack seeded and the given OP_UI_BIND_ADDRESS. */
  function seedHome(bind: string | null): string {
    const home = mkdtempSync(join(tmpdir(), 'op-wsloop-'));
    mkdirSync(join(home, 'system', 'stack'), { recursive: true });
    for (const name of ['core.compose.yml', 'services.compose.yml', 'portals.compose.yml', OVERLAY]) {
      writeFileSync(join(home, 'system', 'stack', name), 'services: {}\n');
    }
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(
      join(home, 'state', 'stack.env'),
      bind === null ? 'OP_SETUP_COMPLETE=true\n' : `OP_SETUP_COMPLETE=true\nOP_UI_BIND_ADDRESS=${bind}\n`,
    );
    return home;
  }

  const included = (home: string) => discoverStackOverlays(home).some((f) => f.endsWith(OVERLAY));

  test('a concrete LAN bind pulls the overlay in', () => {
    const home = seedHome('192.168.0.201');
    try {
      expect(included(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the default, the wildcard and an unset value leave it out', () => {
    for (const bind of ['127.0.0.1', '0.0.0.0', null]) {
      const home = seedHome(bind);
      try {
        expect(included(home), `bind=${bind ?? 'unset'} should not include the overlay`).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  test('a concrete bind with the file absent does not invent it — the same double-gate every overlay uses', () => {
    const home = seedHome('192.168.0.201');
    try {
      rmSync(join(home, 'system', 'stack', OVERLAY));
      expect(included(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
