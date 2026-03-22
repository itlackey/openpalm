import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  loadSecretsEnvFile,
  readSystemSecretsEnvFile,
  updateSecretsEnv,
  updateSystemSecretsEnv,
} from './secrets.js';

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

export type SecretBackendCapabilities = {
  generate: boolean;
  remove: boolean;
  rename: boolean;
};

export interface SecretBackend {
  readonly provider: 'plaintext' | 'pass';
  readonly capabilities: SecretBackendCapabilities;
  list(prefix?: string): Promise<SecretEntryMetadata[]>;
  write(key: string, value: string): Promise<SecretEntryMetadata>;
  generate(key: string, length?: number): Promise<SecretEntryMetadata>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function generateSecretValue(length = 32): string {
  // Hex encoding produces two output characters per byte. Clamp to at least
  // 16 bytes (32 hex chars) so generated secrets stay comfortably strong.
  return randomBytes(Math.max(16, Math.ceil(length / 2))).toString('hex').slice(0, length);
}

function resolvePlaintextTarget(state: ControlPlaneState, key: string): ResolvedSecretTarget {
  const systemEnv = readSystemSecretsEnvFile(state.vaultDir);
  const coreMapping = findCoreSecretByKey(key, systemEnv);
  if (coreMapping) {
    return { key, scope: coreMapping.scope, envKey: coreMapping.envKey };
  }

  const indexed = ensurePlaintextSecretEntry(state, key);
  return { key, scope: indexed.scope, envKey: indexed.envKey };
}

function currentValueForTarget(state: ControlPlaneState, target: ResolvedSecretTarget): string {
  if (!target.envKey) return '';
  const env = target.scope === 'system'
    ? readSystemSecretsEnvFile(state.vaultDir)
    : loadSecretsEnvFile(state.vaultDir);
  return env[target.envKey] ?? '';
}

export class PlaintextBackend implements SecretBackend {
  readonly provider = 'plaintext' as const;
  readonly capabilities = { generate: true, remove: true, rename: false } as const;

  constructor(private readonly state: ControlPlaneState) {}

  async list(prefix = 'openpalm/'): Promise<SecretEntryMetadata[]> {
    const userEnv = loadSecretsEnvFile(this.state.vaultDir);
    const systemEnv = readSystemSecretsEnvFile(this.state.vaultDir);
    const index = readPlaintextSecretIndex(this.state);
    const entries: SecretEntryMetadata[] = [];

    for (const mapping of getCoreSecretMappings(systemEnv)) {
      if (!mapping.secretKey.startsWith(prefix)) continue;
      const env = mapping.scope === 'system' ? systemEnv : userEnv;
      entries.push({
        key: mapping.secretKey,
        scope: mapping.scope,
        kind: 'core',
        provider: this.provider,
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
        provider: this.provider,
        present: Boolean(env[entry.envKey]),
        envKey: entry.envKey,
        updatedAt: entry.updatedAt,
      });
    }

    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
  }

  async write(key: string, value: string): Promise<SecretEntryMetadata> {
    const target = resolvePlaintextTarget(this.state, key);
    if (!target.envKey) {
      throw new Error(`Unable to resolve env key for secret ${key}`);
    }

    if (target.scope === 'system') {
      updateSystemSecretsEnv(this.state, { [target.envKey]: value });
    } else {
      updateSecretsEnv(this.state, { [target.envKey]: value });
    }

    return {
      key,
      scope: target.scope,
      kind: key.startsWith('openpalm/component/') ? 'component' : key.startsWith('openpalm/custom/') ? 'custom' : 'core',
      provider: this.provider,
      present: true,
      envKey: target.envKey,
    };
  }

  async generate(key: string, length = 32): Promise<SecretEntryMetadata> {
    return this.write(key, generateSecretValue(length));
  }

  async remove(key: string): Promise<void> {
    const target = resolvePlaintextTarget(this.state, key);
    if (target.envKey) {
      if (target.scope === 'system') {
        updateSystemSecretsEnv(this.state, { [target.envKey]: '' });
      } else {
        updateSecretsEnv(this.state, { [target.envKey]: '' });
      }
    }
    if (!findCoreSecretByKey(key, readSystemSecretsEnvFile(this.state.vaultDir))) {
      removePlaintextSecretEntry(this.state, key);
    }
  }

  async exists(key: string): Promise<boolean> {
    const target = resolvePlaintextTarget(this.state, key);
    return currentValueForTarget(this.state, target).length > 0;
  }
}

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

export class PassBackend implements SecretBackend {
  readonly provider = 'pass' as const;
  readonly capabilities = { generate: true, remove: true, rename: false } as const;
  private readonly passwordStoreDir: string;
  private readonly passPrefix: string;

  constructor(private readonly state: ControlPlaneState) {
    const config = readSecretProviderConfig(state);
    this.passwordStoreDir = config?.passwordStoreDir ?? `${state.dataDir}/secrets/pass-store`;
    this.passPrefix = config?.passPrefix ?? '';
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PASSWORD_STORE_DIR: this.passwordStoreDir,
    };
  }

  /** Prepend passPrefix to a canonical key for pass store operations. */
  private prefixedEntry(canonicalKey: string): string {
    const entry = validatePassEntryName(canonicalKey);
    return this.passPrefix ? `${this.passPrefix}/${entry}` : entry;
  }

  private keyPath(key: string): string {
    const prefixed = this.prefixedEntry(key);
    const normalizedEntry = normalize(prefixed);
    const resolvedPath = resolve(this.passwordStoreDir, `${normalizedEntry}.gpg`);
    const resolvedStore = resolve(this.passwordStoreDir);
    if (!resolvedPath.startsWith(`${resolvedStore}/`)) {
      throw new Error('Secret key resolves outside the password store');
    }
    return resolvedPath;
  }

  async list(prefix = 'openpalm/'): Promise<SecretEntryMetadata[]> {
    // Scope walk to the passPrefix subdirectory
    const walkDir = this.passPrefix
      ? join(this.passwordStoreDir, this.passPrefix)
      : this.passwordStoreDir;
    return walkPassStore(walkDir)
      .filter((entry) => entry.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b))
      .map((key) => ({
        key,
        scope: classifySecretScope(key),
        kind: classifySecretKey(key),
        provider: this.provider,
        present: true,
      }));
  }

  async write(key: string, value: string): Promise<SecretEntryMetadata> {
    const canonicalKey = validatePassEntryName(key);
    const storeEntry = this.prefixedEntry(canonicalKey);
    await execWithInput('pass', ['insert', '-m', '-f', storeEntry], `${value}\n`, this.env());
    return {
      key: canonicalKey,
      scope: classifySecretScope(canonicalKey),
      kind: classifySecretKey(canonicalKey),
      provider: this.provider,
      present: true,
    };
  }

  async generate(key: string, length = 32): Promise<SecretEntryMetadata> {
    const canonicalKey = validatePassEntryName(key);
    const storeEntry = this.prefixedEntry(canonicalKey);
    await execFile('pass', ['generate', '-n', '-f', storeEntry, String(length)], {
      env: this.env(),
    });
    return {
      key: canonicalKey,
      scope: classifySecretScope(canonicalKey),
      kind: classifySecretKey(canonicalKey),
      provider: this.provider,
      present: true,
    };
  }

  async remove(key: string): Promise<void> {
    const storeEntry = this.prefixedEntry(key);
    await execFile('pass', ['rm', '-f', storeEntry], {
      env: this.env(),
    });
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.keyPath(key));
  }
}

export function detectSecretBackend(state: ControlPlaneState): SecretBackend {
  const providerConfig = readSecretProviderConfig(state);
  if (providerConfig?.provider === 'pass') {
    return new PassBackend(state);
  }

  for (const schemaPath of [`${state.vaultDir}/user/user.env.schema`, `${state.vaultDir}/stack/stack.env.schema`]) {
    if (!existsSync(schemaPath)) continue;
    const content = readFileSync(schemaPath, 'utf-8');
    if (content.includes('@varlock/pass-plugin')) {
      return new PassBackend(state);
    }
  }

  return new PlaintextBackend(state);
}
