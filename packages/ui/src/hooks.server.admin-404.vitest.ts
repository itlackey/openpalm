/**
 * Phase 4 — `/admin/*` becomes a dead namespace ("No /admin alias", issue #555).
 *
 * Contract pinned here:
 *  - The `routes/admin/` tree is DELETED: pages move to `routes/host/`, the
 *    JSON endpoints move under `routes/api/host/` (see the guard-hygiene
 *    suite) and `routes/api/assistant/`. With the tree gone, SvelteKit's
 *    router answers `/admin/*` with 404.
 *  - hooks.server.ts must let `/admin/*` FALL THROUGH to that router 404:
 *    no `features.admin` gate redirect to /chat, no `/admin/endpoints` →
 *    `/connections` alias (the Phase 2 alias was 0.13.0-only), and no
 *    launch-routing redirect swallowing the path. The tests emulate the
 *    router in the `resolve` stub (404 when no route file exists on disk),
 *    so "hooks passes through + files deleted" is asserted as one observable
 *    outcome: the final response is 404.
 *  - The Phase 3 TODO constant flips: HOST_ADMIN_LANDING === '/host', the
 *    installed-offline landing redirect goes to /host, and the runtime
 *    context route pointer `routes.host` is '/host' (nav must never point at
 *    a 404).
 *  - The features.admin ROUTE GATE in hooks.server.ts is replaced by
 *    capability checks (Phase 4 step 4): the hooks source no longer reads
 *    computeFeatureFlags / features.admin. (Whether the derived alias itself
 *    can be deleted from features.ts / +layout.server.ts is a grep-and-note
 *    decision for the implementation — deliberately not asserted here.)
 *
 * RED until Phase 4 lands. Deterministic like hooks.server.landing.vitest.ts:
 * the host probes (composePs, detectRuntime, listRemoteStatuses) are stubbed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { RequestEvent } from '@sveltejs/kit';
import { resetState } from '$lib/server/test-helpers.js';
import { HOST_ADMIN_LANDING } from '$lib/resolve-landing.js';
import { computeServerRuntimeContext } from '$lib/server/features.js';

vi.mock('$lib/server/opencode-target.js', async (orig) => ({
  ...(await orig<typeof import('$lib/server/opencode-target.js')>()),
  listRemoteStatuses: vi.fn(async () => []),
}));
vi.mock('@openpalm/lib', async (orig) => ({
  ...(await orig<typeof import('@openpalm/lib')>()),
  composePs: vi.fn(async () => ({ ok: false, stdout: '', stderr: '', code: 1 })),
  detectRuntime: vi.fn(async () => ({ dockerPresent: false, composeAvailable: false })),
}));

import { composePs } from '@openpalm/lib';
import { handle, _resetLaunchCache } from './hooks.server.js';

const SRC_DIR = fileURLToPath(new URL('./', import.meta.url));
const ROUTES_DIR = join(SRC_DIR, 'routes');

// ── helpers (same conventions as hooks.server.landing.vitest.ts) ─────────────

function seedStackEnv(stackDir: string, setupComplete: boolean): void {
  const kvDir = join(stackDir, '..', '..', 'knowledge', 'env');
  mkdirSync(kvDir, { recursive: true });
  writeFileSync(join(kvDir, 'stack.env'), `OP_SETUP_COMPLETE=${setupComplete}\n`);
}

function makeEvent(path: string, opts: { token?: string; accept?: string } = {}): RequestEvent {
  const url = new URL(`http://localhost:3880${path}`);
  const headers: Record<string, string> = {
    host: 'localhost:3880',
    accept: opts.accept ?? 'text/html',
  };
  if (opts.token) headers.cookie = `op_session=${opts.token}`;
  return {
    url,
    request: new Request(url.toString(), { headers }),
    params: {},
    locals: {} as App.Locals,
    route: { id: path },
    platform: undefined,
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as RequestEvent;
}

/**
 * Router-emulating resolve: 404 when no route file exists for the path —
 * exactly what SvelteKit's router does once `routes/admin/` is deleted.
 * Today `routes/admin/+page.svelte` & friends still exist, so `/admin/*`
 * resolves 200 and these tests are red for the honest reason.
 */
const routerResolve = (event: RequestEvent) => {
  const dir = join(ROUTES_DIR, event.url.pathname.replace(/^\//, ''));
  const exists = ['+page.svelte', '+page.server.ts', '+server.ts'].some((f) =>
    existsSync(join(dir, f)),
  );
  return Promise.resolve(
    exists ? new Response('ok', { status: 200 }) : new Response('Not Found', { status: 404 }),
  );
};

/**
 * Run handle() and capture a thrown SvelteKit redirect as the outcome — the
 * Phase 4 assertions distinguish "passed through to the router" (a Response)
 * from "an alias/gate redirect survived" (a thrown {status, location}).
 */
async function handleOutcome(event: RequestEvent): Promise<unknown> {
  try {
    return await handle({ event, resolve: routerResolve });
  } catch (thrown) {
    return thrown;
  }
}

const MODE_ENV_KEYS = ['OP_INSIDE_ELECTRON', 'OP_ENABLE_ADMIN'] as const;

describe('hooks.server — /admin/* is a dead namespace, no alias', () => {
  let home = '';
  let prevHome: string | undefined;
  let savedModeEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    process.env.PORT = '3880';
    savedModeEnv = {};
    for (const key of MODE_ENV_KEYS) {
      savedModeEnv[key] = process.env[key];
      delete process.env[key];
    }
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-hooks-admin404-'));
    process.env.OP_HOME = home;
    _resetLaunchCache(); // the 5s launch cache is module-level — resolve fresh per test
    vi.mocked(composePs).mockResolvedValue({ ok: false, stdout: '', stderr: '', code: 1 });
    resetState('test-admin-pw'); // seeds 'test-admin-pw' as a valid op_session token
  });

  afterEach(() => {
    delete process.env.PORT;
    for (const key of MODE_ENV_KEYS) {
      const prev = savedModeEnv[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('authenticated /admin document navigation is a router 404, not the dashboard', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const event = makeEvent('/admin', { token: 'test-admin-pw' });

    const outcome = await handleOutcome(event);

    // A thrown SvelteKit redirect ({status, location}) would mean an alias
    // survived; a 200 means routes/admin/+page.svelte still exists.
    expect(outcome, '/admin must fall through to the router, not redirect').toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(404);
  });

  test('/admin/endpoints no longer aliases to /connections (Phase 2 alias removed)', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    const event = makeEvent('/admin/endpoints', { token: 'test-admin-pw' });

    const outcome = await handleOutcome(event);

    expect(outcome, '/admin/endpoints must 404, not redirect to /connections').toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(404);
  });

  test('/admin document navigation in non-admin mode 404s instead of redirecting to /chat', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    const event = makeEvent('/admin', { token: 'test-admin-pw' });

    const outcome = await handleOutcome(event);

    expect(outcome, 'the features.admin gate redirect to /chat must be gone').toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(404);
  });

  test('/admin/* fetch in non-admin mode 404s instead of redirecting to /chat', async () => {
    delete process.env.OP_ENABLE_ADMIN;
    // Browser fetch() sends Accept: */* — never the document-navigation guard.
    const event = makeEvent('/admin/akm', { accept: 'application/json' });

    const outcome = await handleOutcome(event);

    expect(outcome, 'API-style /admin requests must 404, not 302').toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(404);
  });

  test('/ with an installed-but-offline stack lands on /host (was /admin)', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const state = resetState('test-admin-pw');
    seedStackEnv(state.stackDir, true); // setup complete, composePs fails → installed_offline

    await expect(handle({ event: makeEvent('/'), resolve: routerResolve })).rejects.toMatchObject({
      location: '/host',
    });
  });
});

// ── route split: routes/admin deleted, routes/host created (Phase 4 step 1) ──

describe('route files — /admin moved to /host', () => {
  test('the routes/admin/ tree is deleted (pages → routes/host, APIs → routes/api/host)', () => {
    expect(existsSync(join(ROUTES_DIR, 'admin'))).toBe(false);
  });

  test('the /host dashboard route exists', () => {
    expect(existsSync(join(ROUTES_DIR, '(app)', 'host', '+page.svelte'))).toBe(true);
  });
});

// ── the Phase 3 TODO constants flip to /host ──────────────────────────────────

describe('host landing + route pointers flip to /host', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MODE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MODE_ENV_KEYS) {
      const prev = savedEnv[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  test("HOST_ADMIN_LANDING is '/host' (resolve-landing TODO(phase-4) resolved)", () => {
    expect(HOST_ADMIN_LANDING).toBe('/host');
  });

  test("runtime context routes.host points at '/host' — nav must never point at a 404", () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const url = new URL('http://127.0.0.1:3880/host');
    const ctx = computeServerRuntimeContext({ url } as unknown as RequestEvent);
    expect(ctx.routes.host).toBe('/host');
  });
});

// ── hooks hygiene: the features.admin gate is replaced (Phase 4 step 4) ──────

describe('hooks hygiene — features.admin route gate replaced by capability checks', () => {
  test('hooks.server.ts no longer reads computeFeatureFlags / features.admin', () => {
    const source = readFileSync(join(SRC_DIR, 'hooks.server.ts'), 'utf-8');
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /computeFeatureFlags|features\.admin/.test(line))
      .map(({ n, line }) => `hooks.server.ts:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
