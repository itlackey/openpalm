import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, normalize, resolve } from 'node:path';
import type { ControlPlaneState } from './types.js';
import {
  classifySecretKey,
  classifySecretScope,
  ensurePlaintextSecretEntry,
  findCoreSecretByKey,
  getCoreSecretMappings,
  readPlaintextSecretIndex,
  removePlaintextSecretEntry,
  type SecretEntryMetadata,
  type SecretScope,
} from './secret-mappings.js';
import { readSecretProviderConfig } from './provider-config.js';
import {
  readStackEnv,
  updateSecretsEnv,
  updateSystemSecretsEnv,
} from './secrets.js';
import { readUserVaultSync } from './akm-vault.js';

const execFile = promisify(execFileCb);

/** Run a command with stdin input, returning a promise. */
function execWithInput(
  cmd: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
    });
    child.stdin?.end(input);
  });
}

type ResolvedSecretTarget = {
  key: string;
  scope: SecretScope;
  envKey?: string;
};

/**
 * Public shape returned by `detectSecretBackend`. Both the plaintext and
 * pass implementations expose the same surface — a small set of async
 * methods plus a `provider` tag and a flat `capabilities` object.
 *
 * Kept as a `type` alias of an inline object literal so consumers don't
 * have to import a separate interface or capabilities type.
 */
export type SecretBackend = {
  readonly provider: 'plaintext' | 'pass';
  readonly capabilities: { generate: boolean; remove: boolean; rename: boolean };
  list(prefix?: string): Promise<SecretEntryMetadata[]>;
  write(key: string, value: string): Promise<SecretEntryMetadata>;
  generate(key: string, length?: number): Promise<SecretEntryMetadata>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
};

function generateSecretValue(length = 32): string {
  // Hex encoding produces two output characters per byte. Clamp to at least
  // 16 bytes (32 hex chars) so generated secrets stay comfortably strong.
  return randomBytes(Math.max(16, Math.ceil(length / 2))).toString('hex').slice(0, length);
}

function resolvePlaintextTarget(state: ControlPlaneState, key: string): ResolvedSecretTarget {
  const systemEnv = readStackEnv(state.vaultDir);
  const coreMapping = findCoreSecretByKey(key, systemEnv);
  if (coreMapping) {
    return { key, scope: coreMapping.scope, envKey: coreMapping.envKey };
  }

  const indexed = ensurePlaintextSecretEntry(state, key);
  return { key, scope: indexed.scope, envKey: indexed.envKey };
}

function currentValueForTarget(state: ControlPlaneState, target: ResolvedSecretTarget): string {
  if (!target.envKey) return '';
  if (target.scope === 'system') {
    return readStackEnv(state.vaultDir)[target.envKey] ?? '';
  }
  // User scope: the akm `vault:user` store is the canonical user-managed env
  // namespace post-#421. Fall back to stack.env for legacy/consolidated
  // secrets so older layouts keep resolving.
  const userEnv = readUserVaultSync(state);
  if (target.envKey in userEnv) return userEnv[target.envKey];
  return readStackEnv(state.vaultDir)[target.envKey] ?? '';
}

// ── Plaintext backend ─────────────────────────────────────────────────────

export async function plaintextList(state: ControlPlaneState, prefix = 'openpalm/'): Promise<SecretEntryMetadata[]> {
  const systemEnv = readStackEnv(state.vaultDir);
  const userEnvFile = readUserVaultSync(state);
  // Legacy/consolidated secrets may live in stack.env even for user scope.
  // Layer the user vault on top so explicit user-managed values win.
  const userEnv: Record<string, string> = { ...systemEnv, ...userEnvFile };
  const index = readPlaintextSecretIndex(state);
  const entries: SecretEntryMetadata[] = [];

  for (const mapping of getCoreSecretMappings(systemEnv)) {
    if (!mapping.secretKey.startsWith(prefix)) continue;
    const env = mapping.scope === 'system' ? systemEnv : userEnv;
    entries.push({
      key: mapping.secretKey,
      scope: mapping.scope,
      kind: 'core',
      provider: 'plaintext',
      present: Boolean(env[mapping.envKey]),
      envKey: mapping.envKey,
    });
  }

  for (const [key, entry] of Object.entries(index.entries)) {
    if (!key.startsWith(prefix)) continue;
    const env = entry.scope === 'system' ? systemEnv : userEnv;
    entries.push({
      key,
      scope: entry.scope,
      kind: entry.kind,
      provider: 'plaintext',
      present: Boolean(env[entry.envKey]),
      envKey: entry.envKey,
      updatedAt: entry.updatedAt,
    });
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}

export async function plaintextWrite(state: ControlPlaneState, key: string, value: string): Promise<SecretEntryMetadata> {
  const target = resolvePlaintextTarget(state, key);
  if (!target.envKey) {
    throw new Error(`Unable to resolve env key for secret ${key}`);
  }

  if (target.scope === 'system') {
    updateSystemSecretsEnv(state, { [target.envKey]: value });
  } else {
    updateSecretsEnv(state, { [target.envKey]: value });
  }

  return {
    key,
    scope: target.scope,
    kind: key.startsWith('openpalm/component/') ? 'component' : key.startsWith('openpalm/custom/') ? 'custom' : 'core',
    provider: 'plaintext',
    present: true,
    envKey: target.envKey,
  };
}

export async function plaintextGenerate(state: ControlPlaneState, key: string, length = 32): Promise<SecretEntryMetadata> {
  return plaintextWrite(state, key, generateSecretValue(length));
}

export async function plaintextRemove(state: ControlPlaneState, key: string): Promise<void> {
  const target = resolvePlaintextTarget(state, key);
  if (target.envKey) {
    if (target.scope === 'system') {
      updateSystemSecretsEnv(state, { [target.envKey]: '' });
    } else {
      updateSecretsEnv(state, { [target.envKey]: '' });
    }
  }
  if (!findCoreSecretByKey(key, readStackEnv(state.vaultDir))) {
    removePlaintextSecretEntry(state, key);
  }
}

export async function plaintextExists(state: ControlPlaneState, key: string): Promise<boolean> {
  const target = resolvePlaintextTarget(state, key);
  return currentValueForTarget(state, target).length > 0;
}

function makePlaintextBackend(state: ControlPlaneState): SecretBackend {
  return {
    provider: 'plaintext',
    capabilities: { generate: true, remove: true, rename: false },
    list: (prefix) => plaintextList(state, prefix),
    write: (key, value) => plaintextWrite(state, key, value),
    generate: (key, length) => plaintextGenerate(state, key, length),
    remove: (key) => plaintextRemove(state, key),
    exists: (key) => plaintextExists(state, key),
  };
}

// ── Pass backend ──────────────────────────────────────────────────────────

export function validatePassEntryName(entry: string): string {
  const trimmed = entry.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    throw new Error('Secret key must not be empty');
  }
  if (trimmed.includes('..')) {
    throw new Error('Secret key must not contain path traversal');
  }
  if (!/^[a-z0-9._/-]+$/.test(trimmed)) {
    throw new Error('Secret key contains invalid characters');
  }
  return trimmed;
}

function walkPassStore(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const entries: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...walkPassStore(fullPath, prefix ? `${prefix}/${entry}` : entry));
      continue;
    }
    if (!entry.endsWith('.gpg')) continue;
    const name = entry.replace(/\.gpg$/, '');
    entries.push(prefix ? `${prefix}/${name}` : name);
  }
  return entries;
}

/**
 * Resolved pass-backend configuration. Kept as a small in-file struct so the
 * five `pass*` helpers below share one place where defaults
 * (`${dataDir}/secrets/pass-store`, empty prefix) are applied — inlining the
 * `?? defaults` logic into each helper would multiply the truth source.
 * The two strings travel together everywhere (passEnv, prefixedEntry,
 * passKeyPath) so they're worth bundling.
 */
type PassContext = {
  passwordStoreDir: string;
  passPrefix: string;
};

function passContext(state: ControlPlaneState): PassContext {
  const config = readSecretProviderConfig(state);
  return {
    passwordStoreDir: config?.passwordStoreDir ?? `${state.dataDir}/secrets/pass-store`,
    passPrefix: config?.passPrefix ?? '',
  };
}

function passEnv(ctx: PassContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PASSWORD_STORE_DIR: ctx.passwordStoreDir,
  };
}

/** Prepend passPrefix to a canonical key for pass store operations. */
function prefixedEntry(ctx: PassContext, canonicalKey: string): string {
  const entry = validatePassEntryName(canonicalKey);
  return ctx.passPrefix ? `${ctx.passPrefix}/${entry}` : entry;
}

function passKeyPath(ctx: PassContext, key: string): string {
  const prefixed = prefixedEntry(ctx, key);
  const normalizedEntry = normalize(prefixed);
  const resolvedPath = resolve(ctx.passwordStoreDir, `${normalizedEntry}.gpg`);
  const resolvedStore = resolve(ctx.passwordStoreDir);
  if (!resolvedPath.startsWith(`${resolvedStore}/`)) {
    throw new Error('Secret key resolves outside the password store');
  }
  return resolvedPath;
}

export async function passList(state: ControlPlaneState, prefix = 'openpalm/'): Promise<SecretEntryMetadata[]> {
  const ctx = passContext(state);
  // Scope walk to the passPrefix subdirectory
  const walkDir = ctx.passPrefix
    ? join(ctx.passwordStoreDir, ctx.passPrefix)
    : ctx.passwordStoreDir;
  return walkPassStore(walkDir)
    .filter((entry) => entry.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      key,
      scope: classifySecretScope(key),
      kind: classifySecretKey(key),
      provider: 'pass',
      present: true,
    }));
}

export async function passWrite(state: ControlPlaneState, key: string, value: string): Promise<SecretEntryMetadata> {
  const ctx = passContext(state);
  const canonicalKey = validatePassEntryName(key);
  const storeEntry = prefixedEntry(ctx, canonicalKey);
  await execWithInput('pass', ['insert', '-m', '-f', storeEntry], `${value}\n`, passEnv(ctx));
  return {
    key: canonicalKey,
    scope: classifySecretScope(canonicalKey),
    kind: classifySecretKey(canonicalKey),
    provider: 'pass',
    present: true,
  };
}

export async function passGenerate(state: ControlPlaneState, key: string, length = 32): Promise<SecretEntryMetadata> {
  const ctx = passContext(state);
  const canonicalKey = validatePassEntryName(key);
  const storeEntry = prefixedEntry(ctx, canonicalKey);
  await execFile('pass', ['generate', '-n', '-f', storeEntry, String(length)], {
    env: passEnv(ctx),
  });
  return {
    key: canonicalKey,
    scope: classifySecretScope(canonicalKey),
    kind: classifySecretKey(canonicalKey),
    provider: 'pass',
    present: true,
  };
}

export async function passRemove(state: ControlPlaneState, key: string): Promise<void> {
  const ctx = passContext(state);
  const storeEntry = prefixedEntry(ctx, key);
  await execFile('pass', ['rm', '-f', storeEntry], {
    env: passEnv(ctx),
  });
}

export async function passExists(state: ControlPlaneState, key: string): Promise<boolean> {
  const ctx = passContext(state);
  return existsSync(passKeyPath(ctx, key));
}

function makePassBackend(state: ControlPlaneState): SecretBackend {
  return {
    provider: 'pass',
    capabilities: { generate: true, remove: true, rename: false },
    list: (prefix) => passList(state, prefix),
    write: (key, value) => passWrite(state, key, value),
    generate: (key, length) => passGenerate(state, key, length),
    remove: (key) => passRemove(state, key),
    exists: (key) => passExists(state, key),
  };
}

export function detectSecretBackend(state: ControlPlaneState): SecretBackend {
  const providerConfig = readSecretProviderConfig(state);
  if (providerConfig?.provider === 'pass') {
    return makePassBackend(state);
  }

  // Historical fallback: pre-#391 we sniffed `.env.schema` files for a
  // `@varlock/pass-plugin` marker. Schemas are gone; operators who want
  // `pass` set `secret-provider.json` to `{ "provider": "pass" }`.
  return makePlaintextBackend(state);
}
