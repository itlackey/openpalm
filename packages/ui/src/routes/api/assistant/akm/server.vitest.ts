/**
 * Tests for /api/assistant/akm — assistant-SCOPED AKM configuration.
 *
 * Contract under test — the AkmTab split + the akm 0.9 schema:
 *  - The AKM runtime config (config/akm/config.json) is assistant-scoped →
 *    lives under /api/assistant/akm, guarded by the assistant-settings
 *    capabilities + requireAdmin.
 *  - assistant-settings:read/write are BASE capabilities present in every
 *    process → GET/PATCH 200 regardless of admin capability; the requireAdmin
 *    cookie check is still enforced (401 without a session).
 *  - akm 0.9 hard break: `engines.<name>` (kind "llm"|"agent") replaces
 *    profiles.llm/agent; `improve.strategies.<name>` replaces profiles.improve;
 *    defaults are llmEngine/engine/improveStrategy. PATCH always writes
 *    configVersion "0.9.0", pins bundles.openpalm + defaultBundle, and strips
 *    every retired 0.8 key from the merged output.
 *  - Host-LEVEL AKM (host key sharing) stays under /api/host — pinned by
 *    routes/api/host/guard-hygiene.vitest.ts, not here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type AssistantAkmRouteModule = { GET: RouteHandler; PATCH: RouteHandler };

/** RED-state-safe loader (same pattern as the Phase 2 /api/connections suite). */
async function loadRoute(): Promise<AssistantAkmRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as AssistantAkmRouteModule;
}

let homeDir = '';

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-assistant-akm-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function akmConfigFile(): string {
  return join(homeDir, 'config', 'akm', 'config.json');
}

function seedAkmConfig(config: Record<string, unknown>): void {
  mkdirSync(join(homeDir, 'config', 'akm'), { recursive: true });
  writeFileSync(akmConfigFile(), JSON.stringify(config));
}

function readWrittenConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(akmConfigFile(), 'utf-8')) as Record<string, unknown>;
}

function makeGetEvent(token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/assistant/akm');
  return {
    url,
    request: new Request(url, {
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-assistant-akm-get',
      },
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/assistant/akm' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

function makePatchEvent(body: Record<string, unknown>, token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/assistant/akm');
  return {
    url,
    request: new Request(url, {
      method: 'PATCH',
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-assistant-akm-patch',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/assistant/akm' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

const ENV_KEYS = [
  'OP_INSIDE_ELECTRON',
  'OP_ENABLE_ADMIN',
  'OP_HOME',
  'OP_UI_LOGIN_PASSWORD',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  homeDir = makeTempHome();
  process.env.OP_HOME = homeDir;
  resetState('admin-token');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  cleanupTempDirs();
});

describe('GET /api/assistant/akm — assistant-scoped AKM config', () => {
  test('200 in a non-admin process with a valid session — returns the config', async () => {
    seedAkmConfig({ configVersion: '0.9.0', defaults: { llmEngine: 'main' } });
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: Record<string, unknown> };
    expect((body.config.defaults as Record<string, unknown>).llmEngine).toBe('main');
  });

  test('401 without a session cookie (requireAdmin still enforced)', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent(''));
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/assistant/akm — the browser can edit AKM (Phase 4 acceptance)', () => {
  test('200 in a non-admin process: the patch is persisted to config/akm/config.json', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent({ defaults: { llmEngine: 'primary' } }));
    expect(res.status).toBe(200);
    expect(readFileSync(akmConfigFile(), 'utf-8')).toContain('primary');
  });

  test('200 in an admin process too (assistant-settings:write is a base capability)', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent({ defaults: { llmEngine: 'primary' } }));
    expect(res.status).toBe(200);
    expect(readFileSync(akmConfigFile(), 'utf-8')).toContain('primary');
  });
});

describe('PATCH /api/assistant/akm — akm 0.9 engines map', () => {
  test('round-trips llm + agent engines through one engines map', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      makePatchEvent({
        engines: {
          main: {
            kind: 'llm',
            endpoint: 'https://api.openai.com/v1/chat/completions',
            model: 'gpt-4o-mini',
            provider: 'openai',
            apiKey: '${AKM_LLM_API_KEY}',
            temperature: 0.2,
            maxTokens: 4096,
            supportsJsonSchema: true,
            extraParams: { top_p: 0.9 },
          },
          runner: { kind: 'agent', platform: 'claude', bin: 'claude', args: ['-p'], timeoutMs: 60000 },
        },
      }),
    );
    expect(res.status).toBe(200);
    const config = readWrittenConfig();
    const engines = config.engines as Record<string, Record<string, unknown>>;
    expect(engines.main.kind).toBe('llm');
    expect(engines.main.endpoint).toBe('https://api.openai.com/v1/chat/completions');
    expect(engines.main.extraParams).toEqual({ top_p: 0.9 });
    expect(engines.runner).toEqual({ kind: 'agent', platform: 'claude', bin: 'claude', args: ['-p'], timeoutMs: 60000 });
  });

  test('an unmodeled engine field survives a PATCH, and a cleared endpoint keeps the persisted one', async () => {
    seedAkmConfig({
      configVersion: '0.9.0',
      engines: {
        main: {
          kind: 'llm',
          endpoint: 'https://api.openai.com/v1/chat/completions',
          model: 'gpt-4o-mini',
          // real akm 0.9 schema field the UI does not model — must survive a save
          capabilities: ['vision'],
        },
      },
    });
    const { PATCH } = await loadRoute();
    // The AKM tab rebuilds the whole engines map from its drawers: only the
    // UI-modeled fields come back, and a cleared endpoint is simply absent.
    const res = await PATCH(
      makePatchEvent({ engines: { main: { kind: 'llm', model: 'gpt-4o' } } }),
    );
    expect(res.status).toBe(200);
    const engines = readWrittenConfig().engines as Record<string, Record<string, unknown>>;
    expect(engines.main.capabilities).toEqual(['vision']);
    expect(engines.main.model).toBe('gpt-4o');
    // Cleared endpoint falls back to the persisted one instead of producing a
    // bare {kind:'llm'} engine akm's schema rejects.
    expect(engines.main.endpoint).toBe('https://api.openai.com/v1/chat/completions');
  });

  test('accepts llmEngine on an opencode-sdk agent engine, rejects it elsewhere', async () => {
    const { PATCH } = await loadRoute();
    const ok = await PATCH(
      makePatchEvent({ engines: { sdk: { kind: 'agent', platform: 'opencode-sdk', llmEngine: 'main' } } }),
    );
    expect(ok.status).toBe(200);
    expect((readWrittenConfig().engines as Record<string, Record<string, unknown>>).sdk.llmEngine).toBe('main');

    const bad = await PATCH(
      makePatchEvent({ engines: { run: { kind: 'agent', platform: 'claude', llmEngine: 'main' } } }),
    );
    expect(bad.status).toBe(400);
  });

  test('400 for a missing/invalid engine kind', async () => {
    const { PATCH } = await loadRoute();
    const missing = await PATCH(makePatchEvent({ engines: { main: { endpoint: 'http://x' } } }));
    expect(missing.status).toBe(400);
    const invalid = await PATCH(makePatchEvent({ engines: { main: { kind: 'wizard' } } }));
    expect(invalid.status).toBe(400);
  });

  test('400 for an invalid agent platform', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent({ engines: { run: { kind: 'agent', platform: 'cursor' } } }));
    expect(res.status).toBe(400);
  });

  test('accepts every 0.9 agent platform', async () => {
    const { PATCH } = await loadRoute();
    for (const platform of ['opencode','claude','opencode-sdk','codex','copilot','pi','gemini','aider','amazonq','openhands']) {
      const res = await PATCH(makePatchEvent({ engines: { run: { kind: 'agent', platform } } }));
      expect(res.status, platform).toBe(200);
    }
  });

  test('400 for engine names that violate the kebab-case rule', async () => {
    const { PATCH } = await loadRoute();
    for (const name of ['akm-reserved', 'Bad', 'has_underscore', '9starts-with-digit', '-leading-dash']) {
      const res = await PATCH(makePatchEvent({ engines: { [name]: { kind: 'llm' } } }));
      expect(res.status, name).toBe(400);
    }
  });

  test('400 for a non-symbolic llm apiKey (akm 0.9 requires $VAR / ${VAR})', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      makePatchEvent({ engines: { main: { kind: 'llm', apiKey: 'sk-raw-secret' } } }),
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/assistant/akm — defaults (0.9 keys)', () => {
  test('persists defaults.llmEngine / defaults.engine / defaults.improveStrategy', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      makePatchEvent({ defaults: { llmEngine: 'main', engine: 'runner', improveStrategy: 'default' } }),
    );
    expect(res.status).toBe(200);
    expect(readWrittenConfig().defaults).toEqual({ llmEngine: 'main', engine: 'runner', improveStrategy: 'default' });
  });

  test('400 for non-string defaults', async () => {
    const { PATCH } = await loadRoute();
    for (const body of [
      { defaults: { llmEngine: 7 } },
      { defaults: { engine: {} } },
      { defaults: { improveStrategy: false } },
    ]) {
      const res = await PATCH(makePatchEvent(body));
      expect(res.status).toBe(400);
    }
  });
});

describe('PATCH /api/assistant/akm — improve.strategies (0.9)', () => {
  test('persists a strategy with processes using engine (no mode/profile)', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      makePatchEvent({
        improve: {
          strategies: {
            default: {
              description: 'default strategy',
              limit: 30,
              engine: 'main',
              processes: {
                reflect: { enabled: true, engine: 'main', timeoutMs: 12000 },
                triage: { enabled: true, applyMode: 'promote', judgment: { engine: 'main', timeoutMs: 9000 } },
              },
              sync: { enabled: true, push: false, message: 'akm improve sync' },
            },
          },
          eventRetentionDays: 90,
        },
      }),
    );
    expect(res.status).toBe(200);
    const improve = readWrittenConfig().improve as Record<string, unknown>;
    const strategy = (improve.strategies as Record<string, Record<string, unknown>>).default;
    expect(strategy.limit).toBe(30);
    expect(strategy.engine).toBe('main');
    expect((strategy.processes as Record<string, Record<string, unknown>>).triage.judgment).toEqual({ engine: 'main', timeoutMs: 9000 });
    expect(improve.eventRetentionDays).toBe(90);
  });

  test('an improve PATCH without utilityDecay/eventRetentionDays leaves the stored values untouched', async () => {
    // Key-presence merge semantics, same as defaults/embedding/output: absent
    // keys are not deletions. A strategies-only save used to wipe both knobs.
    seedAkmConfig({
      configVersion: '0.9.0',
      improve: {
        utilityDecay: { halfLifeDays: 14, feedbackStabilityBoost: 2 },
        eventRetentionDays: 90,
      },
    });
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      makePatchEvent({ improve: { strategies: { default: { limit: 10 } } } }),
    );
    expect(res.status).toBe(200);
    const improve = readWrittenConfig().improve as Record<string, unknown>;
    expect(improve.utilityDecay).toEqual({ halfLifeDays: 14, feedbackStabilityBoost: 2 });
    expect(improve.eventRetentionDays).toBe(90);
    expect((improve.strategies as Record<string, Record<string, unknown>>).default.limit).toBe(10);
  });

  test('400 for the retired process mode/profile pair and judgment mode', async () => {
    const { PATCH } = await loadRoute();
    for (const proc of [
      { enabled: true, mode: 'llm' },
      { enabled: true, profile: 'default' },
      { enabled: true, judgment: { mode: 'llm' } },
    ]) {
      const res = await PATCH(
        makePatchEvent({ improve: { strategies: { s: { processes: { reflect: proc } } } } }),
      );
      expect(res.status).toBe(400);
    }
  });

  test('400 for the retired autoAccept strategy field', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      makePatchEvent({ improve: { strategies: { s: { autoAccept: 0.9 } } } }),
    );
    expect(res.status).toBe(400);
  });

  test('400 for an unrecognized process name; accepts the 0.9 additions', async () => {
    const { PATCH } = await loadRoute();
    const bad = await PATCH(
      makePatchEvent({ improve: { strategies: { s: { processes: { mystery: { enabled: true } } } } } }),
    );
    expect(bad.status).toBe(400);
    const ok = await PATCH(
      makePatchEvent({
        improve: {
          strategies: {
            s: { processes: { triagePromote: { enabled: true }, memoryCleanup: { enabled: false }, akmExtract: { enabled: true } } },
          },
        },
      }),
    );
    expect(ok.status).toBe(200);
  });
});

describe('PATCH /api/assistant/akm — 0.9 invariants (configVersion, bundle pin, retired keys)', () => {
  test('always writes configVersion 0.9.0 and pins the openpalm bundle', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent({ semanticSearchMode: 'off' }));
    expect(res.status).toBe(200);
    const config = readWrittenConfig();
    expect(config.configVersion).toBe('0.9.0');
    expect((config.bundles as Record<string, unknown>).openpalm).toEqual({ path: '/stash', writable: true });
    expect(config.defaultBundle).toBe('openpalm');
  });

  test('keeps an existing defaultBundle string instead of overwriting it', async () => {
    seedAkmConfig({ configVersion: '0.9.0', defaultBundle: 'other', bundles: { other: { path: '/elsewhere' } } });
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent({ semanticSearchMode: 'auto' }));
    expect(res.status).toBe(200);
    const config = readWrittenConfig();
    expect(config.defaultBundle).toBe('other');
    // pin still added alongside the existing bundle
    expect((config.bundles as Record<string, unknown>).openpalm).toEqual({ path: '/stash', writable: true });
    expect((config.bundles as Record<string, unknown>).other).toEqual({ path: '/elsewhere' });
  });

  test('the request body can never set bundles / defaultBundle / stashDir', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      makePatchEvent({
        bundles: { evil: { path: '/etc' } },
        defaultBundle: 'evil',
        stashDir: '/etc',
      }),
    );
    expect(res.status).toBe(200);
    const config = readWrittenConfig();
    expect(config.bundles).toEqual({ openpalm: { path: '/stash', writable: true } });
    expect(config.defaultBundle).toBe('openpalm');
    expect(config).not.toHaveProperty('stashDir');
  });

  // #645/#654: this used to seed `profiles.llm.default` with no `model` field,
  // which `translateLegacyLlmProfiles` correctly declines to translate (an
  // untranslatable profile is dropped with a loud warning, not silently kept)
  // — so the test asserted only that `profiles` vanished, never checking
  // whether the endpoint actually reached `engines`. That encoded the exact
  // data loss #645 reported as the spec. Seeding a REALISTIC pre-upgrade
  // profile (the full `/chat/completions` URL 0.12.x wrote, a model, a
  // provider) inverts it: the retired keys still go, but the operator's LLM
  // configuration must survive the translation, not just disappear with them.
  //
  // Route/migration split (#654): `stripRetiredAkmConfigKeys` — the SAME
  // translate-then-strip primitive (`stripRetiredAkmKeys`, setup.ts) this
  // route already calls — moved out of `applyHomeAssets`'s unconditional
  // per-launch sweep and into a versioned home-schema MIGRATION, because that
  // passive sweep is what silently ran the strip with no requirement to
  // translate first. This ROUTE's own call to `stripRetiredAkmKeys` is
  // different in kind: it is the explicit write path an operator's own PATCH
  // takes, already gated behind the same translate step (never bypassed), so
  // it stays exactly where it is — an operator editing their config through
  // the UI must always land on a config akm can load, migration or not.
  test('translates a pre-upgrade profiles.llm profile into engines on the first PATCH, instead of silently dropping it', async () => {
    seedAkmConfig({
      profiles: {
        llm: {
          default: {
            endpoint: 'https://api.openai.com/v1/chat/completions',
            model: 'gpt-4o-mini',
            provider: 'openai',
          },
        },
      },
      llm: { endpoint: 'http://x' },
      agent: { platform: 'opencode' },
      features: { extract: true },
      stashes: {},
      stashDir: '/stash',
      sources: [{ options: { pushOnCommit: true } }],
      installed: {},
      wikiName: 'openpalm',
      defaults: { llm: 'default', agent: 'opencode', improve: 'default' },
      semanticSearchMode: 'auto',
    });
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent({ defaults: { llmEngine: 'main' } }));
    expect(res.status).toBe(200);
    const config = readWrittenConfig();
    for (const key of ['profiles','llm','agent','features','stashes','stashDir','sources','installed','wikiName']) {
      expect(config, key).not.toHaveProperty(key);
    }
    // The whole point: the retired profile reached `engines`, not the void.
    expect(config.engines).toEqual({
      default: {
        kind: 'llm',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
        provider: 'openai',
      },
    });
    // `defaults.llmEngine` is set — to the operator's OWN explicit PATCH
    // value ('main'), which the translation correctly does not clobber
    // (additive merge: an already-set llmEngine always wins).
    expect(config.defaults).toEqual({ llmEngine: 'main' });
    expect(config.configVersion).toBe('0.9.0');
    expect(config.semanticSearchMode).toBe('auto');
  });
});
