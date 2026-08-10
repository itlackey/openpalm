import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stackEnvFile, writeSecret } from '@openpalm/lib';

const mocks = vi.hoisted(() => ({ on: vi.fn() }));

vi.mock('electron', () => ({ app: { on: mocks.on } }));

import { configureAssistantWorkspaceAuth } from '../src/assistant-auth.js';

/** A challenge from this install's own OpenCode. Overridden per case. */
const CHALLENGE = { isProxy: false, scheme: 'basic', host: '127.0.0.1', port: 3810 };
/** `assistantDirect` on: OpenCode publishes on 3810 and requires Basic auth. */
const AUTH_ON = 'OP_ASSISTANT_PORT=3810\nOPENCODE_AUTH=true\n';
const KEY = 'generated-key';

let homeDir = '';

function seedHome(stackEnv: string, password?: string): void {
  const envFile = stackEnvFile(homeDir);
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(envFile, stackEnv);
  // Via the lib writer, so the test can't drift from the delegated-secret
  // routing (`isDelegatedSecretName`) that decides where this file lives.
  if (password !== undefined) writeSecret(homeDir, 'op_opencode_password', password);
}

/** Invoke the registered `login` listener and report what it did. */
function login(challenge = CHALLENGE): {
  prevented: boolean;
  credential: [string?, string?] | null;
} {
  configureAssistantWorkspaceAuth(homeDir);
  const listener = mocks.on.mock.calls.find(([event]) => event === 'login')?.[1] as (
    ...args: unknown[]
  ) => void;
  let prevented = false;
  let credential: [string?, string?] | null = null;
  listener(
    { preventDefault: () => { prevented = true; } },
    null,
    {},
    challenge,
    (username?: string, password?: string) => { credential = [username, password]; },
  );
  return { prevented, credential };
}

const IGNORED = { prevented: false, credential: null };

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-assistant-auth-'));
  mocks.on.mockClear();
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('the target follows this install’s own assistant port', () => {
  it('answers on the configured port and ignores the default one', () => {
    seedHome('OP_ASSISTANT_PORT=4810\nOPENCODE_AUTH=true\n', KEY);
    expect(login({ ...CHALLENGE, port: 4810 })).toEqual({
      prevented: true,
      credential: ['opencode', KEY],
    });
    expect(login()).toEqual(IGNORED);
  });
});

describe('the login handler answers OpenCode and nothing else', () => {
  beforeEach(() => seedHome(AUTH_ON, KEY));

  it('supplies the generated key when OpenCode requires auth', () => {
    expect(login()).toEqual({ prevented: true, credential: ['opencode', KEY] });
  });

  it('ignores a proxy challenge — a middlebox in front of the app is not the assistant', () => {
    expect(login({ ...CHALLENGE, isProxy: true })).toEqual(IGNORED);
  });

  it('ignores a non-Basic scheme', () => {
    expect(login({ ...CHALLENGE, scheme: 'negotiate' })).toEqual(IGNORED);
  });

  it('ignores another local port — a stray service must not receive the assistant key', () => {
    expect(login({ ...CHALLENGE, port: 3800 })).toEqual(IGNORED);
  });

  it('ignores another host', () => {
    expect(login({ ...CHALLENGE, host: 'evil.example' })).toEqual(IGNORED);
  });
});

describe('the login handler stays out of the way when OpenCode needs no auth', () => {
  it('offers nothing though the secret file exists', () => {
    // ensureSecrets always materializes the file, so its presence says nothing
    // about whether OpenCode authenticates — OPENCODE_AUTH is the gate.
    seedHome('OP_ASSISTANT_PORT=3810\nOPENCODE_AUTH=false\n', KEY);
    expect(login()).toEqual(IGNORED);
  });
});
