/**
 * The CLI's pre-wizard seed (prepareInstallFiles -> writeSystemEnv ->
 * generateFallbackSystemEnv) used to bake OP_UI_PORT / OP_ASSISTANT_PORT /
 * OP_WORKSPACE_PORT into a fresh state/stack.env before anything had looked
 * at the host. Those rows read as an operator's explicit choice, so the
 * deploy's host-aware pass (ensureHostPortDefaults, run from
 * applyManagedFiles) never probed them, and a second `openpalm install` on
 * one host landed on the same ports with nothing able to move them.
 *
 * This drives the REAL install path (`bootstrapInstall --file --no-start`,
 * which needs no Docker) into a temp OP_HOME, then the same host-aware pass
 * the first apply runs, with a real listener holding the assistant default.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { createState, ensureHostPortDefaults, HOST_PORT_DEFAULTS } from '@openpalm/lib';
import { bootstrapInstall } from './install.ts';

const SPEC = `version: 2
llm:
  provider: openai
  model: gpt-4o
  baseUrl: https://api.openai.com/v1
embedding:
  provider: openai
  model: text-embedding-3-small
  dims: 1536
  baseUrl: https://api.openai.com/v1
security:
  uiLoginPassword: port-seed-test-password
owner:
  name: Port Seed
  email: port-seed@example.com
connections: []
`;

// install persists any OP_*_PORT already in the shell as a deliberate
// override (install.ts runtimeOverrides); keep the test's shell clean.
const SHELL_PORT_KEYS = ['OP_PROJECT_NAME', 'OP_ASSISTANT_PORT', 'OP_UI_PORT', 'OP_HOST_UI_PORT', 'OP_WORKSPACE_PORT'];
const saved: Record<string, string | undefined> = {};
let tempHome = '';
let listener: Server | null = null;

beforeEach(() => {
  for (const key of SHELL_PORT_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  saved.OP_HOME = process.env.OP_HOME;
  tempHome = mkdtempSync(join(tmpdir(), 'openpalm-port-seed-'));
  process.env.OP_HOME = tempHome;
});

afterEach(() => {
  listener?.stop(true);
  listener = null;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe('a fresh install leaves compose-published ports to the host-aware apply', () => {
  test('bootstrapInstall --file --no-start seeds no port rows, and the first apply bumps a busy default', async () => {
    const specPath = join(tempHome, 'setup.yaml');
    writeFileSync(specPath, SPEC);
    await bootstrapInstall({ force: false, noStart: true, noOpen: true, file: specPath, assumeYes: true });

    const stackEnvPath = join(tempHome, 'state', 'stack.env');
    const seeded = readFileSync(stackEnvPath, 'utf-8');
    for (const key of ['OP_UI_PORT', 'OP_ASSISTANT_PORT', 'OP_WORKSPACE_PORT']) {
      expect(seeded, `${key} must not be baked before the host is checked`).not.toMatch(new RegExp(`^${key}=`, 'm'));
    }

    const assistant = HOST_PORT_DEFAULTS.find((d) => d.key === 'OP_ASSISTANT_PORT');
    if (!assistant) throw new Error('OP_ASSISTANT_PORT is missing from HOST_PORT_DEFAULTS');
    // A sibling instance already holds the assistant default.
    listener = Bun.serve({ port: assistant.default, hostname: '127.0.0.1', fetch: () => new Response('busy') });

    await ensureHostPortDefaults(createState());

    const after = readFileSync(stackEnvPath, 'utf-8');
    const persisted = /^OP_ASSISTANT_PORT=(\d+)$/m.exec(after)?.[1];
    expect(persisted, 'the busy assistant default is persisted to a free port').toBeDefined();
    expect(Number(persisted)).not.toBe(assistant.default);
    expect(Number(persisted)).toBeGreaterThan(assistant.default);
    // Free defaults stay absent: absence still means "the release default".
    expect(after).not.toMatch(/^OP_UI_PORT=/m);
    expect(after).not.toMatch(/^OP_WORKSPACE_PORT=/m);
  });
});
