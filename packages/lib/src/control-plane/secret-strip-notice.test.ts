import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState } from './lifecycle.js';
import {
  writeSystemEnv,
  readSecretStripNotice,
  dismissSecretStripNotice,
  secretStripNoticePath,
} from './config-persistence.js';
import { readSecret } from './secrets-files.js';

let homeDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-secret-strip-'));
  savedHome = process.env.OP_HOME;
  process.env.OP_HOME = homeDir;
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(homeDir, 'state'), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('#502 secret-strip notice', () => {
  it('records a one-time notice when secret-like keys are stripped from stack.env', () => {
    const state = createState();
    writeFileSync(
      join(homeDir, 'state', 'stack.env'),
      `OP_HOME=${homeDir}\nOPENAI_API_KEY=sk-leak\nDISCORD_BOT_TOKEN=tok\nOP_LOG_LEVEL=info\n`,
    );

    writeSystemEnv(state);

    const notice = readSecretStripNotice(state);
    expect(notice).not.toBeNull();
    expect(notice?.keys).toContain('OPENAI_API_KEY');
    expect(notice?.keys).toContain('DISCORD_BOT_TOKEN');
    expect(notice?.keys).not.toContain('OP_LOG_LEVEL');
    expect(typeof notice?.at).toBe('string');
  });

  it('does not create a notice when there are no secret-like keys', () => {
    const state = createState();
    writeFileSync(
      join(homeDir, 'state', 'stack.env'),
      `OP_HOME=${homeDir}\nOP_LOG_LEVEL=info\n`,
    );

    writeSystemEnv(state);

    expect(readSecretStripNotice(state)).toBeNull();
    expect(existsSync(secretStripNoticePath(state))).toBe(false);
  });

  it('accumulates keys across writes and dismisses cleanly', () => {
    const state = createState();
    writeFileSync(
      join(homeDir, 'state', 'stack.env'),
      'OPENAI_API_KEY=sk-a\n',
    );
    writeSystemEnv(state);
    writeFileSync(
      join(homeDir, 'state', 'stack.env'),
      'GROQ_API_KEY=gsk-b\n',
    );
    writeSystemEnv(state);

    const notice = readSecretStripNotice(state);
    expect(notice).not.toBeNull();
    expect(notice?.keys).toContain('OPENAI_API_KEY');
    expect(notice?.keys).toContain('GROQ_API_KEY');

    dismissSecretStripNotice(state);
    expect(readSecretStripNotice(state)).toBeNull();
  });

  it('relocates a stripped secret value to knowledge/secrets/<key> instead of destroying it (0.1)', () => {
    const state = createState();
    writeFileSync(
      join(homeDir, 'state', 'stack.env'),
      `OP_HOME=${homeDir}\nOPENAI_API_KEY=sk-leaked-value\nOP_LOG_LEVEL=info\n`,
    );

    writeSystemEnv(state);

    // The value must survive somewhere the user (and the app) can recover it —
    // not just the key name in the notice.
    expect(readSecret(state.homeDir, 'openai_api_key')).toBe('sk-leaked-value\n');
    const notice = readSecretStripNotice(state);
    expect(notice?.keys).toContain('OPENAI_API_KEY');
  });
});
