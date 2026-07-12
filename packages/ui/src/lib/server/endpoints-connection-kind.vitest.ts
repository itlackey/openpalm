/**
 * Phase 2 (#486) — ConnectionKind defaulting on the endpoints store (plan
 * ui-runtime-modes-plan.md §6.6; decision table §2: "endpoints.json rename —
 * Do not rename. Add `kind` field. Internal model uses 'connection'
 * language.").
 *
 * RED until Phase 2 lands: entries returned by listEndpoints() /
 * getActiveEndpoint() carry no `kind` yet. `kind` is read through a cast
 * helper (`kindOf`) so svelte-check stays clean while the suite is red —
 * the assertions fail at runtime with `undefined` until the field exists.
 *
 * Contract under test:
 *  - Legacy endpoints.json records (no `kind` key on disk) default to
 *    'remote-opencode' when read.
 *  - The env-derived default entry defaults to 'local-opencode'.
 *  - CHARACTERIZATION (green pre-change, must stay green): a record
 *    persisted WITH an explicit kind keeps it on read (the store already
 *    passes unknown on-disk keys through — Phase 2 must not strip or
 *    override it); and the on-disk file keeps its name and schema keys
 *    (`activeId` / `endpoints`) — Phase 2 renames the internal model only,
 *    never the persisted schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { _replaceState, getState } from './state.js';
import { makeTestState, registerCleanup, trackDir } from './test-helpers.js';
import {
  addEndpoint,
  getActiveEndpoint,
  listEndpoints,
  setActiveId,
  updateEndpoint,
  _resetRemoteStatusCache,
  listRemoteStatuses,
} from './endpoints.js';

registerCleanup();

const ENV_KEYS = [
  'OP_OPENCODE_URL',
  'OP_ASSISTANT_URL',
  'OP_ASSISTANT_PORT',
  'OPENCODE_SERVER_PASSWORD',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  const state = makeTestState();
  trackDir(state.dataDir);
  trackDir(state.configDir);
  mkdirSync(state.dataDir, { recursive: true });
  mkdirSync(state.configDir, { recursive: true });
  _replaceState(state);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Read `kind` without a compile-time dependency on the not-yet-added field. */
function kindOf(entry: unknown): string | undefined {
  return (entry as { kind?: string }).kind;
}

function endpointsJsonPath(): string {
  return `${getState().configDir}/endpoints.json`;
}

/** Seed config/endpoints.json byte-for-byte, as an existing install would have it. */
function seedEndpointsFile(payload: unknown): void {
  writeFileSync(endpointsJsonPath(), JSON.stringify(payload), { mode: 0o600 });
}

/** A legacy (pre-Phase-2) file: records have no `kind` key at all. */
const LEGACY_RECORD_ID = '22222222-2222-4222-8222-222222222222';
function seedLegacyFixture(): void {
  seedEndpointsFile({
    activeId: LEGACY_RECORD_ID,
    endpoints: [
      { id: LEGACY_RECORD_ID, label: 'Legacy Remote', url: 'http://10.0.0.9:3800', password: 'shh' },
    ],
  });
}

describe('ConnectionKind defaulting on read (plan §6.6)', () => {
  it("defaults legacy user records (no kind on disk) to 'remote-opencode' in listEndpoints()", () => {
    seedLegacyFixture();
    const list = listEndpoints();
    const legacy = list.find((e) => e.id === LEGACY_RECORD_ID);
    expect(legacy).toBeDefined();
    expect(kindOf(legacy)).toBe('remote-opencode');
  });

  it("defaults the legacy active record to 'remote-opencode' in getActiveEndpoint()", () => {
    seedLegacyFixture();
    const active = getActiveEndpoint();
    expect(active.id).toBe(LEGACY_RECORD_ID);
    expect(kindOf(active)).toBe('remote-opencode');
  });

  it("marks the env-derived default entry as 'local-opencode' in listEndpoints()", () => {
    seedLegacyFixture();
    const list = listEndpoints();
    const dflt = list.find((e) => e.id === 'default');
    expect(dflt).toBeDefined();
    expect(kindOf(dflt)).toBe('local-opencode');
  });

  it("marks the env-derived default entry as 'local-opencode' when it is the active endpoint", () => {
    // Fresh install: no endpoints.json at all — the default is active.
    const active = getActiveEndpoint();
    expect(active.isDefault).toBe(true);
    expect(kindOf(active)).toBe('local-opencode');
  });

});

describe('endpoints.json on-disk schema is NOT renamed (CHARACTERIZATION — green pre-change)', () => {
  it('preserves an explicitly persisted kind on read (unknown keys already pass through)', () => {
    seedEndpointsFile({
      activeId: null,
      endpoints: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          label: 'Client API',
          url: 'https://palm.example:8443',
          kind: 'openpalm-client-api',
        },
      ],
    });
    const list = listEndpoints();
    const entry = list.find((e) => e.id === '33333333-3333-4333-8333-333333333333');
    expect(entry).toBeDefined();
    expect(kindOf(entry)).toBe('openpalm-client-api');
  });

  it('writes through the store keep the legacy schema keys (activeId/endpoints)', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'http://10.0.0.9:3800' });
    setActiveId(entry.id);
    const parsed = JSON.parse(readFileSync(endpointsJsonPath(), 'utf-8')) as Record<string, unknown>;
    expect(parsed).toHaveProperty('endpoints');
    expect(parsed).toHaveProperty('activeId', entry.id);
    expect(parsed).not.toHaveProperty('connections');
  });

  it('legacy records load without any data migration (Phase 2 acceptance: "no data migration")', () => {
    seedLegacyFixture();
    const list = listEndpoints();
    // [default, legacy record] — the legacy record is intact.
    const legacy = list.find((e) => e.id === LEGACY_RECORD_ID);
    expect(legacy).toMatchObject({
      id: LEGACY_RECORD_ID,
      label: 'Legacy Remote',
      url: 'http://10.0.0.9:3800',
      password: 'shh',
      isDefault: false,
    });
  });
});

// ── #486 D2: kind persistence on write ────────────────────────────────────────

describe('kind persistence on write (#486 D2)', () => {
  it("addEndpoint persists an explicit kind 'openpalm-client-api' to disk and returns it", () => {
    const entry = addEndpoint({
      label: 'Guardian',
      url: 'https://gw.example:8443/oc',
      kind: 'openpalm-client-api',
    } as Parameters<typeof addEndpoint>[0]);
    expect(kindOf(entry)).toBe('openpalm-client-api');
    const parsed = JSON.parse(readFileSync(endpointsJsonPath(), 'utf-8')) as {
      endpoints: Array<{ id: string; kind?: string }>;
    };
    const onDisk = parsed.endpoints.find((e) => e.id === entry.id);
    expect(onDisk).toBeDefined();
    expect(onDisk?.kind).toBe('openpalm-client-api');
  });

  it('addEndpoint without kind writes no kind key (legacy on-disk shape preserved)', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'http://10.0.0.9:3800' });
    const parsed = JSON.parse(readFileSync(endpointsJsonPath(), 'utf-8')) as {
      endpoints: Array<Record<string, unknown>>;
    };
    const onDisk = parsed.endpoints.find((e) => e.id === entry.id);
    expect(onDisk).toBeDefined();
    expect(onDisk).not.toHaveProperty('kind');
  });

  it('updateEndpoint can set kind on an existing record', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'http://10.0.0.9:3800' });
    expect(kindOf(entry)).toBeUndefined();
    const updated = updateEndpoint(entry.id, {
      kind: 'openpalm-client-api',
    } as Parameters<typeof updateEndpoint>[1]);
    expect(kindOf(updated)).toBe('openpalm-client-api');
  });

  it('addEndpoint normalizes a guardian-kind URL to end in /oc', () => {
    const entry = addEndpoint({
      label: 'Guardian',
      url: 'http://10.0.0.9:3830',
      kind: 'openpalm-client-api',
    } as Parameters<typeof addEndpoint>[0]);
    expect(entry.url).toBe('http://10.0.0.9:3830/oc');
  });

  it('listRemoteStatuses probes ${url}/session for guardian-kind entries', async () => {
    addEndpoint({
      label: 'Guardian',
      url: 'http://10.0.0.9:3830/oc',
      kind: 'openpalm-client-api',
    } as Parameters<typeof addEndpoint>[0]);
    addEndpoint({ label: 'Plain remote', url: 'http://10.0.0.10:3800' });

    const probedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      probedUrls.push(String(input));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      _resetRemoteStatusCache();
      await listRemoteStatuses();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(probedUrls).toContain('http://10.0.0.9:3830/oc/session');
    expect(probedUrls).toContain('http://10.0.0.10:3800');
  });
});
