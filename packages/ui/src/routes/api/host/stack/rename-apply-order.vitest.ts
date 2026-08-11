/**
 * A save that renames the project AND flips an access toggle must apply the
 * toggle to the project that is actually RUNNING.
 *
 * OP_PROJECT_NAME used to ride along in `applyAccessToggles`'s `extraEnv`, so
 * the new name landed in stack.env before the apply's own `compose ps` / `up`
 * — and both resolve `--project-name` from that env file
 * (buildComposeCommandArgs -> collectComposeEnvOverrides). The apply therefore
 * addressed a project that did not exist yet: `ps` returned nothing, the
 * recreate scope came out empty, no container was touched, and the response
 * still advertised over mDNS. The toggle read back as applied while the
 * running stack kept its old published ports.
 *
 * The observable invariant without Docker: at the moment applyAccessToggles
 * runs, stack.env still names the OLD project; the rename lands after.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** OP_PROJECT_NAME as stack.env held it when applyAccessToggles was entered. */
let projectNameDuringApply: string | null = null;

vi.mock('@openpalm/lib', async (orig) => {
  const actual = await orig<typeof import('@openpalm/lib')>();
  return {
    ...actual,
    applyAccessToggles: (...args: Parameters<typeof actual.applyAccessToggles>) => {
      const [state] = args;
      const path = join(state.homeDir, 'state', 'stack.env');
      const content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
      projectNameDuringApply = content.match(/^OP_PROJECT_NAME=(.*)$/m)?.[1] ?? null;
      return actual.applyAccessToggles(...args);
    },
  };
});

const { resetState } = await import('$lib/server/test-helpers.js');
const { PUT } = await import('./+server.js');

let rootDir = '';
let originalHome: string | undefined;

function makePutEvent(body: unknown) {
  const url = new URL('http://localhost/api/host/stack');
  return {
    request: new Request(url, {
      method: 'PUT',
      headers: {
        cookie: 'op_session=admin-token',
        'x-request-id': 'req-host-stack-order',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    url,
    params: {},
  } as Parameters<typeof PUT>[0];
}

const ALL_OFF = {
  networkAccess: false,
  assistantDirect: false,
  guardianNetwork: false,
  guardianOpenaiApi: false,
};

beforeEach(() => {
  process.env.OP_ENABLE_ADMIN = '1';
  rootDir = join(tmpdir(), `openpalm-stack-order-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  projectNameDuringApply = null;
  resetState('admin-token');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = originalHome;
  delete process.env.OP_ENABLE_ADMIN;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('PUT /api/host/stack — rename + toggle ordering', () => {
  test('the toggle apply sees the OLD project name; the rename lands after it', async () => {
    const res = await PUT(
      makePutEvent({ projectName: 'renamed-stack', access: { ...ALL_OFF, networkAccess: true } }),
    );
    expect(res.status).toBe(200);

    // The apply ran against the project that is actually running — either the
    // pre-save name or an unset key (a fresh home), never the new name.
    expect(projectNameDuringApply).not.toBe('renamed-stack');

    // ...and the rename still landed, with the marker the next apply needs.
    const stackEnv = readFileSync(join(rootDir, 'state', 'stack.env'), 'utf-8');
    expect(stackEnv).toMatch(/^OP_PROJECT_NAME=renamed-stack$/m);
    expect(stackEnv).toMatch(/^OP_UI_BIND_ADDRESS=0\.0\.0\.0$/m);
    expect((await res.json() as Record<string, unknown>).projectRenamed).toBe(true);
  });

  test('a toggle-only save (no rename) still applies and reports no rename', async () => {
    const res = await PUT(
      makePutEvent({ projectName: 'openpalm', access: { ...ALL_OFF, networkAccess: true } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.projectRenamed).toBe(false);
    expect(readFileSync(join(rootDir, 'state', 'stack.env'), 'utf-8')).toMatch(
      /^OP_UI_BIND_ADDRESS=0\.0\.0\.0$/m,
    );
  });
});
