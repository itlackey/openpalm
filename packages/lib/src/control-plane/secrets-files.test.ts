import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildEnvFiles } from './config-persistence.js';
import { assertNoSecretLikeStackEnvKeys, patchSecretsEnvFile } from './secrets.js';
import { listSecretNames, readSecret, resolveStateSecretsDir, resolveSecretsDir, secretPath, writeSecret, ensureSecret, listSecretFiles, readSecretFile, writeSecretFile, removeSecretFile, assertSafeSecretFilename, AGENT_READABLE_SECRET_NAMES } from './secrets-files.js';
import { stateSecretsDir, secretsDir } from './home.js';
import type { ControlPlaneState } from './types.js';

function tempStackDir(): string {
  return mkdtempSync(join(tmpdir(), 'openpalm-secrets-files-'));
}

describe('file-based control-plane secrets', () => {
  it('creates the secrets directory and files with private permissions', () => {
    const stackDir = tempStackDir();

    writeSecret(stackDir, 'portal_chat_secret', 'value');

    expect(resolveStateSecretsDir(stackDir)).toBe(join(stackDir, 'state', 'secrets'));
    expect(statSync(resolveStateSecretsDir(stackDir)).mode & 0o777).toBe(0o700);
    expect(statSync(secretPath(stackDir, 'portal_chat_secret')).mode & 0o777).toBe(0o600);
    expect(readSecret(stackDir, 'portal_chat_secret')).toBe('value');
    expect(listSecretNames(stackDir)).toEqual(['portal_chat_secret']);
  });

  it('rejects invalid secret names', () => {
    const stackDir = tempStackDir();

    expect(() => writeSecret(stackDir, 'CHANNEL_CHAT_SECRET', 'value')).toThrow(/Invalid secret name/);
    expect(() => writeSecret(stackDir, 'channel-chat-secret', 'value')).toThrow(/Invalid secret name/);
  });

  it('rejects secret-like stack.env keys', () => {
    expect(() => assertNoSecretLikeStackEnvKeys({ OPENAI_API_KEY: 'sk-test' })).toThrow(/OPENAI_API_KEY/);
    expect(() => assertNoSecretLikeStackEnvKeys({ OP_OWNER_NAME: 'Ada' })).not.toThrow();
  });

  it('does not include file-based secrets in compose env files', () => {
    const homeDir = tempStackDir(); // a temp OP_HOME root for this test
    const stashDir = join(homeDir, 'knowledge');
    const stackEnv = join(homeDir, 'state', 'stack.env');
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stackEnv, 'OP_HOME=/tmp/openpalm\n');
    writeSecret(homeDir, 'portal_chat_secret', 'value');
    const state = { homeDir, stackDir: join(homeDir, 'config', 'stack'), stashDir } as ControlPlaneState;

    expect(buildEnvFiles(state)).toEqual([stackEnv]); // exactly one env file
  });

  it('reads legacy compose env files without migrating them', () => {
    const homeDir = tempStackDir();
    const knowledgeEnv = join(homeDir, 'knowledge', 'env', 'stack.env');
    const stateEnv = join(homeDir, 'state', 'stack.state.env');
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(knowledgeEnv, 'OP_PROJECT_NAME=legacy\n');
    writeFileSync(stateEnv, 'OP_SETUP_COMPLETE=true\n');
    const state = { homeDir } as ControlPlaneState;

    expect(buildEnvFiles(state)).toEqual([knowledgeEnv, stateEnv]);
  });

  it('routes secret patches to lower-case secret files instead of stack.env', () => {
    const stackDir = tempStackDir();
    writeFileSync(join(stackDir, 'stack.env'), 'OP_SETUP_COMPLETE=false\n');

    patchSecretsEnvFile(stackDir, { OP_UI_LOGIN_PASSWORD: 'pw', OP_ASSISTANT_VERSION: 'latest' });

    expect(readSecret(stackDir, 'op_ui_login_password')).toBe('pw\n');
    expect(listSecretNames(stackDir)).toContain('op_ui_login_password');
  });

  // Routing is default-deny (A2): a secret name resolves under state/secrets/,
  // never under knowledge/secrets/ (bind-mounted wholesale into the assistant at
  // /stash), unless it is explicitly agent-readable. The names below include one
  // (`portal_owner_secret`) that no list anywhere mentions — that is the point:
  // the safe location is what a name gets for free.
  //
  // A round-trip-only test (write then read the same name back) would stay
  // green even if routing were disabled entirely, because both directories are
  // readable/writable the same way. Only asserting the PHYSICAL PATH catches
  // that regression.
  it('routes an unlisted secret name under stateSecretsDir, never secretsDir', () => {
    const homeDir = tempStackDir();

    for (const name of ['op_session_signing_key', 'ts_authkey', 'portal_owner_secret', 'openai_api_key']) {
      expect(AGENT_READABLE_SECRET_NAMES.has(name)).toBe(false);
      const path = secretPath(homeDir, name);
      expect(path).toBe(join(stateSecretsDir(homeDir), name));
      expect(path.startsWith(secretsDir(homeDir))).toBe(false);

      writeSecret(homeDir, name, `value-for-${name}`);
      expect(readSecret(homeDir, name)).toBe(`value-for-${name}`);
      // The value must actually land on disk under state/secrets/, not
      // merely resolve there in-memory.
      expect(statSync(join(stateSecretsDir(homeDir), name)).isFile()).toBe(true);
    }
  });

  it('routes an agent-readable name (auth.json) under secretsDir, never stateSecretsDir', () => {
    const homeDir = tempStackDir();

    expect([...AGENT_READABLE_SECRET_NAMES]).toEqual(['auth.json']);
    writeSecretFile(homeDir, 'auth.json', '{"anthropic":{"type":"api"}}');

    expect(statSync(join(secretsDir(homeDir), 'auth.json')).isFile()).toBe(true);
    expect(existsSync(join(stateSecretsDir(homeDir), 'auth.json'))).toBe(false);
  });

  it('treats a zero-byte (torn) secret file as missing and re-seeds it (0.1)', () => {
    const homeDir = tempStackDir();
    // Simulate a write that was interrupted mid-flight, leaving a 0-byte file.
    const path = secretPath(homeDir, 'op_guardian_admin_token');
    writeFileSync(path, '');
    expect(statSync(path).size).toBe(0);

    const value = ensureSecret(homeDir, 'op_guardian_admin_token', () => 'freshly-seeded-value');

    expect(value).toBe('freshly-seeded-value');
    expect(readSecret(homeDir, 'op_guardian_admin_token')).toBe('freshly-seeded-value');
  });

  it('leaves a blank-but-nonzero secret alone — the file is the operator’s', () => {
    // A newline-only file is 1 byte, so it is not "torn" and is not re-seeded.
    // That is deliberate: emptying op_opencode_password is how someone turns
    // OpenCode's auth off, and silently regenerating it would overwrite that
    // decision. The boot path warns instead of failing, so nothing downstream
    // needs this function to launder the value.
    for (const blank of ['\n', '   ', ' \n\n']) {
      const homeDir = tempStackDir();
      writeFileSync(secretPath(homeDir, 'op_opencode_password'), blank);

      expect(
        ensureSecret(homeDir, 'op_opencode_password', () => 'freshly-seeded-value'),
        JSON.stringify(blank),
      ).toBe(blank);
    }
  });

  it('never rewrites a secret whose value merely LOOKS odd', () => {
    // Surrounding whitespace is preserved everywhere else in this codebase
    // (the entrypoint's `$(cat)` strips trailing newlines only), so a password
    // like "pw " must survive untouched rather than be silently rotated.
    const homeDir = tempStackDir();
    writeSecret(homeDir, 'op_opencode_password', ' pass word \n');

    expect(ensureSecret(homeDir, 'op_opencode_password', () => 'rotated')).toBe(' pass word \n');
  });
});

describe('secrets-dir file browser API (admin Secrets tab)', () => {
  it('lists ALL files incl. dotted names like auth.json, with sizes', () => {
    const stackDir = tempStackDir();
    writeSecret(stackDir, 'portal_api_secret', 'abc');           // regex-valid secret
    writeFileSync(join(resolveSecretsDir(stackDir), 'auth.json'), '{"k":1}'); // dotted file
    const files = listSecretFiles(stackDir);
    const names = files.map((f) => f.name);
    expect(names).toContain('auth.json');           // included (strict listSecretNames would exclude it)
    expect(names).toContain('portal_api_secret');
    expect(files.find((f) => f.name === 'auth.json')?.size).toBe('{"k":1}'.length);
    // strict API still excludes the dotted file
    expect(listSecretNames(stackDir)).not.toContain('auth.json');
  });

  // The listing must agree with the routing, or the Secrets tab edits a file
  // other than the one it shows. `knowledge/secrets` is AKM's own secrets asset
  // dir as well as auth.json's home, so a name in there that is not
  // agent-readable is simply not this tab's file: readSecretFile would resolve
  // it to state/secrets and a save would leave the /stash-visible original
  // untouched while writing a second copy.
  it('does not list a knowledge/secrets file whose name routes to state/secrets', () => {
    const stackDir = tempStackDir();
    writeFileSync(join(resolveSecretsDir(stackDir), 'akm_owned_token'), 'akm-value');

    expect(listSecretFiles(stackDir).map((f) => f.name)).not.toContain('akm_owned_token');
    expect(listSecretNames(stackDir)).not.toContain('akm_owned_token');
    expect(readSecretFile(stackDir, 'akm_owned_token')).toBeNull();
  });

  it('reads, writes (0600), and removes a dotted file by basename', () => {
    const stackDir = tempStackDir();
    writeSecretFile(stackDir, 'auth.json', '{"token":"x"}');
    expect(statSync(join(resolveSecretsDir(stackDir), 'auth.json')).mode & 0o777).toBe(0o600);
    expect(readSecretFile(stackDir, 'auth.json')).toBe('{"token":"x"}');
    removeSecretFile(stackDir, 'auth.json');
    expect(readSecretFile(stackDir, 'auth.json')).toBeNull();
  });

  // auth.json is a single-file bind mount (core.compose.yml): a tmp+rename
  // write would swap it for a new inode while the running assistant container
  // keeps the old, unlinked one open. writeAuthJsonProviderKeys (secrets.ts)
  // is pinned against this by auth-json-inode.test.ts, but writeSecretFile is
  // a SEPARATE writer reaching the same file (the admin Secrets tab's raw file
  // editor) — pin it here too so the two writers cannot silently diverge again.
  it('keeps auth.json\'s inode across a writeSecretFile write', () => {
    const stackDir = tempStackDir();
    const path = join(resolveSecretsDir(stackDir), 'auth.json');
    writeFileSync(path, '{}\n', { mode: 0o600 });
    const before = statSync(path).ino;

    writeSecretFile(stackDir, 'auth.json', '{"token":"x"}');

    expect(statSync(path).ino).toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSecretFile(stackDir, 'auth.json')).toBe('{"token":"x"}');
  });

  it('rejects path traversal and unsafe names', () => {
    expect(() => assertSafeSecretFilename('../escape')).toThrow();
    expect(() => assertSafeSecretFilename('a/b')).toThrow();
    expect(() => assertSafeSecretFilename('..')).toThrow();
    expect(() => assertSafeSecretFilename('')).toThrow();
    // valid names
    expect(() => assertSafeSecretFilename('auth.json')).not.toThrow();
    expect(() => assertSafeSecretFilename('op_ui_login_password')).not.toThrow();
    expect(() => assertSafeSecretFilename('discord_bot_token')).not.toThrow();
  });

  it('readSecretFile returns null for a missing file', () => {
    expect(readSecretFile(tempStackDir(), 'nope.txt')).toBeNull();
  });
});
