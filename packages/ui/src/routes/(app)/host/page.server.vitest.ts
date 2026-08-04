/**
 * The host page resolves its own install state.
 *
 * This load exists because hooks.server.ts cannot answer for the navigation
 * that matters: the in-app admin button is a client-side link, so its data
 * request carries no `Accept: text/html` and every document-navigation guard
 * skips it. A page load runs on both lanes, so both get the same answer — and
 * that is the property these tests pin.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _resetLaunchCache } from '$lib/server/landing.js';
import { load } from './+page.server.js';

/** A home with the compose file materialized and setup marked complete. */
function seedInstalledHome(home: string): void {
  mkdirSync(join(home, 'system', 'stack'), { recursive: true });
  writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
}

const runLoad = () =>
  (load as unknown as () => { stackInstalled: boolean })();

describe('/host +page.server load', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), 'op-host-page-server-'));
    process.env.OP_HOME = home;
    // The install-state cache is process-wide with a 5s TTL, so a stale entry
    // from a sibling test would silently decide this one.
    _resetLaunchCache();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    _resetLaunchCache();
  });

  test('reports no install for an empty home', () => {
    expect(runLoad()).toEqual({ stackInstalled: false });
  });

  test('reports an install once the stack is materialized and setup is complete', () => {
    seedInstalledHome(home);
    _resetLaunchCache();
    expect(runLoad()).toEqual({ stackInstalled: true });
  });

  // A half-finished install still has something to administer, and hooks.server
  // still bounces it to /setup — what it must NOT do is claim nothing is
  // installed, which would show the "install OpenPalm here" notice over a home
  // that already has a stack in it.
  test('treats a setup-incomplete home as installed, not as a fresh machine', () => {
    mkdirSync(join(home, 'system', 'stack'), { recursive: true });
    writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(join(home, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=false\n');
    _resetLaunchCache();
    expect(runLoad()).toEqual({ stackInstalled: true });
  });
});
