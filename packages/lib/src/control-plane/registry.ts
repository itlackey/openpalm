/**
 * Registry catalog discovery and refresh.
 *
 * `OP_HOME/registry` is the only persistent catalog location.
 * Install seeds it once; refresh replaces it explicitly.
 */
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../logger.js';
import {
  resolveRegistryAddonsDir,
  resolveRegistryAutomationsDir,
  resolveRegistryDir,
} from './home.js';

const BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
const URL_RE = /^(https:\/\/|git@)/;
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const logger = createLogger('registry');

let warnedMissingRegistryAddonsDir = false;

export function validateBranch(branch: string): string {
  const normalized = branch.trim();
  if (!BRANCH_RE.test(normalized)) throw new Error(`Invalid registry branch name: ${branch}`);
  if (normalized.includes('..')) throw new Error(`Invalid registry branch name (contains '..'): ${branch}`);
  return normalized;
}

export function validateRegistryUrl(url: string): string {
  const normalized = url.trim();
  if (!normalized.startsWith('/') && !URL_RE.test(normalized)) {
    throw new Error(`Invalid registry URL: ${url}`);
  }
  return normalized;
}

export function isValidComponentName(name: string): boolean {
  return VALID_NAME_RE.test(name);
}

const DEFAULT_REPO = 'itlackey/openpalm';

export interface RegistryConfig {
  repoUrl: string;
  branch: string;
}

export function getRegistryConfig(): RegistryConfig {
  return {
    repoUrl: validateRegistryUrl(process.env.OP_REGISTRY_URL ?? `https://github.com/${DEFAULT_REPO}.git`),
    branch: validateBranch(process.env.OP_REGISTRY_BRANCH ?? 'main'),
  };
}

export type RegistryAutomationEntry = {
  name: string;
  type: 'automation';
  description: string;
  schedule: string;
  ymlContent: string;
};

export type RegistryComponentEntry = {
  compose: string;
  schema: string;
};

export type RegistryAddonConfig = {
  schemaPath: string;
  userEnvPath: string;
  envSchema: string;
};

export type RegistryCatalogVerification = {
  root: string;
  addonCount: number;
  automationCount: number;
};

export type MutationResult = { ok: true } | { ok: false; error: string };

function countValidAddons(rootDir: string): number {
  const addonsDir = join(rootDir, 'addons');
  if (!existsSync(addonsDir)) return 0;
  return readdirSync(addonsDir, { withFileTypes: true }).filter((entry) => {
    if (!entry.isDirectory() || !isValidComponentName(entry.name)) return false;
    const addonDir = join(addonsDir, entry.name);
    return existsSync(join(addonDir, 'compose.yml')) && existsSync(join(addonDir, '.env.schema'));
  }).length;
}

function countValidAutomations(rootDir: string): number {
  const automationsDir = join(rootDir, 'automations');
  if (!existsSync(automationsDir)) return 0;
  return readdirSync(automationsDir).filter((file) => {
    if (!file.endsWith('.yml')) return false;
    return isValidComponentName(file.replace(/\.yml$/, ''));
  }).length;
}

export function verifyRegistryCatalog(rootDir = resolveRegistryDir()): RegistryCatalogVerification {
  const addonCount = countValidAddons(rootDir);
  const automationCount = countValidAutomations(rootDir);

  if (addonCount === 0) throw new Error('Registry catalog is incomplete: missing valid addons');
  if (automationCount === 0) throw new Error('Registry catalog is incomplete: missing valid automations');

  return {
    root: rootDir,
    addonCount,
    automationCount,
  };
}

export function materializeRegistryCatalog(sourceRoot: string): string {
  const sourceAddonsDir = join(sourceRoot, '.openpalm', 'registry', 'addons');
  const sourceAutomationsDir = join(sourceRoot, '.openpalm', 'registry', 'automations');
  const tempRoot = mkdtempSync(join(tmpdir(), 'openpalm-registry-materialize-'));

  try {
    const tempAddonsDir = join(tempRoot, 'addons');
    const tempAutomationsDir = join(tempRoot, 'automations');
    mkdirSync(tempAddonsDir, { recursive: true });
    mkdirSync(tempAutomationsDir, { recursive: true });

    if (existsSync(sourceAddonsDir)) cpSync(sourceAddonsDir, tempAddonsDir, { recursive: true });
    if (existsSync(sourceAutomationsDir)) cpSync(sourceAutomationsDir, tempAutomationsDir, { recursive: true });

    verifyRegistryCatalog(tempRoot);

    rmSync(resolveRegistryDir(), { recursive: true, force: true });
    mkdirSync(resolveRegistryDir(), { recursive: true });
    cpSync(tempAddonsDir, resolveRegistryAddonsDir(), { recursive: true });
    cpSync(tempAutomationsDir, resolveRegistryAutomationsDir(), { recursive: true });
    return resolveRegistryDir();
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function refreshRegistryCatalog(config?: RegistryConfig): RegistryCatalogVerification {
  const raw = config ?? getRegistryConfig();
  const repoUrl = validateRegistryUrl(raw.repoUrl);
  const branch = validateBranch(raw.branch);
  const cloneDir = mkdtempSync(join(tmpdir(), 'openpalm-registry-refresh-'));

  try {
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', branch, repoUrl, '.'],
      { cwd: cloneDir, stdio: 'pipe', timeout: 60_000 },
    );
    execFileSync('git', ['sparse-checkout', 'set', '.openpalm'], {
      cwd: cloneDir,
      stdio: 'pipe',
      timeout: 30_000,
    });
    const root = materializeRegistryCatalog(cloneDir);
    return verifyRegistryCatalog(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to refresh registry from ${repoUrl}: ${msg}`);
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

export function discoverRegistryComponents(): Record<string, RegistryComponentEntry> {
  const addonsDir = resolveRegistryAddonsDir();
  if (!existsSync(addonsDir)) return {};

  const result: Record<string, RegistryComponentEntry> = {};
  for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !VALID_NAME_RE.test(entry.name)) continue;
    const addonDir = join(addonsDir, entry.name);
    const composeFile = join(addonDir, 'compose.yml');
    const schemaFile = join(addonDir, '.env.schema');
    if (!existsSync(composeFile) || !existsSync(schemaFile)) continue;

    result[entry.name] = {
      compose: readFileSync(composeFile, 'utf-8'),
      schema: readFileSync(schemaFile, 'utf-8'),
    };
  }

  return result;
}

export function discoverRegistryAutomations(): RegistryAutomationEntry[] {
  const automationsDir = resolveRegistryAutomationsDir();
  if (!existsSync(automationsDir)) return [];

  return readdirSync(automationsDir)
    .filter((file) => file.endsWith('.yml'))
    .map((file) => {
      const name = file.replace(/\.yml$/, '');
      if (!VALID_NAME_RE.test(name)) return null;

      const ymlContent = readFileSync(join(automationsDir, file), 'utf-8');
      let description = '';
      let schedule = '';

      try {
        const parsed = parseYaml(ymlContent);
        if (parsed && typeof parsed === 'object') {
          description = parsed.description ?? '';
          schedule = parsed.schedule ?? '';
        }
      } catch {
        // best-effort metadata extraction
      }

      return {
        name,
        type: 'automation' as const,
        description,
        schedule,
        ymlContent,
      };
    })
    .filter((entry): entry is RegistryAutomationEntry => entry !== null);
}

export function getRegistryAutomation(name: string): string | null {
  if (!VALID_NAME_RE.test(name)) return null;
  const ymlPath = join(resolveRegistryAutomationsDir(), `${name}.yml`);
  if (!existsSync(ymlPath)) return null;
  return readFileSync(ymlPath, 'utf-8');
}

export function getRegistryAddonConfig(homeDir: string, name: string): RegistryAddonConfig {
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(`Invalid addon name: ${name}`);
  }

  const schemaPath = `registry/addons/${name}/.env.schema`;
  return {
    schemaPath,
    userEnvPath: 'vault/user/user.env',
    envSchema: readFileSync(join(homeDir, schemaPath), 'utf-8'),
  };
}

export function listAvailableAddonIds(): string[] {
  const addonsDir = resolveRegistryAddonsDir();
  if (!existsSync(addonsDir) && !warnedMissingRegistryAddonsDir) {
    warnedMissingRegistryAddonsDir = true;
    logger.warn('registry addons directory is missing', { addonsDir });
  }
  return Object.keys(discoverRegistryComponents()).sort();
}

export function listEnabledAddonIds(homeDir: string): string[] {
  const addonsDir = join(homeDir, 'stack', 'addons');
  if (!existsSync(addonsDir)) return [];

  return readdirSync(addonsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(addonsDir, entry.name, 'compose.yml')))
    .map((entry) => entry.name)
    .sort();
}

function copyAddonFromRegistry(homeDir: string, name: string): void {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);

  const sourceDir = join(resolveRegistryAddonsDir(), name);
  if (!existsSync(join(sourceDir, 'compose.yml')) || !existsSync(join(sourceDir, '.env.schema'))) {
    throw new Error(`Addon "${name}" not found in registry`);
  }

  const targetDir = join(homeDir, 'stack', 'addons', name);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(join(homeDir, 'stack', 'addons'), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
}

function removeEnabledAddon(homeDir: string, name: string): void {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
  rmSync(join(homeDir, 'stack', 'addons', name), { recursive: true, force: true });
}

export function enableAddon(homeDir: string, name: string): MutationResult {
  try {
    copyAddonFromRegistry(homeDir, name);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function disableAddonByName(homeDir: string, name: string): MutationResult {
  try {
    removeEnabledAddon(homeDir, name);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function installAutomationFromRegistry(name: string, configDir: string): MutationResult {
  if (!VALID_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid automation name: ${name}` };
  }

  const automationYml = getRegistryAutomation(name);
  if (!automationYml) {
    return { ok: false, error: `Automation "${name}" not found in registry` };
  }

  const automationsDir = join(configDir, 'automations');
  mkdirSync(automationsDir, { recursive: true });

  const ymlPath = join(automationsDir, `${name}.yml`);
  if (existsSync(ymlPath)) {
    return { ok: false, error: `Automation "${name}" is already installed` };
  }

  writeFileSync(ymlPath, automationYml);
  return { ok: true };
}

export function uninstallAutomation(name: string, configDir: string): MutationResult {
  if (!VALID_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid automation name: ${name}` };
  }

  const ymlPath = join(configDir, 'automations', `${name}.yml`);
  if (!existsSync(ymlPath)) {
    return { ok: false, error: `Automation "${name}" is not installed` };
  }

  rmSync(ymlPath, { force: true });
  return { ok: true };
}
