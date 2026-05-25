/**
 * Registry catalog discovery and refresh.
 *
 * `OP_HOME/state/registry` is the only persistent catalog location.
 * Install seeds it once; refresh replaces it explicitly.
 */
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../logger.js';
import { isChannelAddon } from './channels.js';
import { randomHex, writeChannelSecrets } from './config-persistence.js';
import { patchSecretsEnvFile, readStackEnv } from './secrets.js';
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

export type RegistryConfig = {
  repoUrl: string;
  branch: string;
};

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
  content: string;
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

type MutationResult = { ok: true } | { ok: false; error: string };
export type AddonMutationResult = (
  | { ok: true; enabled: boolean; changed: boolean; services: string[] }
  | { ok: false; error: string }
);

function countValidAddons(rootDir: string): number {
  const addonsDir = join(rootDir, 'addons');
  if (!existsSync(addonsDir)) return 0;
  return readdirSync(addonsDir, { withFileTypes: true }).filter((entry) => {
    if (!entry.isDirectory() || !isValidComponentName(entry.name)) return false;
    const addonDir = join(addonsDir, entry.name);
    // An addon is valid if it has a compose.yml. Overlay-only addons that only
    // patch existing services (ports, env, volumes) do not need an .env.schema;
    // full addons that introduce services and env vars do.
    return existsSync(join(addonDir, 'compose.yml'));
  }).length;
}

function countValidAutomations(rootDir: string): number {
  const automationsDir = join(rootDir, 'automations');
  if (!existsSync(automationsDir)) return 0;
  return readdirSync(automationsDir).filter((file) => {
    if (!file.endsWith('.md')) return false;
    return isValidComponentName(file.replace(/\.md$/, ''));
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
  const sourceAddonsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons');
  const sourceAutomationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');
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
    if (!existsSync(composeFile)) continue;

    // .env.schema is optional: overlay-only addons (e.g. a port toggle) do
    // not introduce new env vars, so they ship just compose.yml.
    const schemaFile = join(addonDir, '.env.schema');
    const schema = existsSync(schemaFile) ? readFileSync(schemaFile, 'utf-8') : '';

    result[entry.name] = {
      compose: readFileSync(composeFile, 'utf-8'),
      schema,
    };
  }

  return result;
}

export function discoverRegistryAutomations(stashDir: string): RegistryAutomationEntry[] {
  const automationsDir = resolveRegistryAutomationsDir();
  if (!existsSync(automationsDir)) return [];

  return readdirSync(automationsDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const name = file.replace(/\.md$/, '');
      if (!VALID_NAME_RE.test(name)) return null;

      const content = readFileSync(join(automationsDir, file), 'utf-8');
      let description = '';
      let schedule = '';

      // Extract frontmatter metadata (between --- delimiters)
      try {
        const after = content.startsWith('---') ? content.slice(3) : '';
        const end = after.indexOf('\n---');
        if (end !== -1) {
          const parsed = parseYaml(after.slice(0, end));
          if (parsed && typeof parsed === 'object') {
            description = (parsed as Record<string, unknown>).description as string ?? '';
            schedule = (parsed as Record<string, unknown>).schedule as string ?? '';
          }
        }
      } catch {
        // best-effort metadata extraction
      }

      return {
        name,
        type: 'automation' as const,
        description,
        schedule,
        content,
      };
    })
    .filter((entry): entry is RegistryAutomationEntry => entry !== null);
}

export function getRegistryAutomation(name: string): string | null {
  if (!VALID_NAME_RE.test(name)) return null;
  const mdPath = join(resolveRegistryAutomationsDir(), `${name}.md`);
  if (!existsSync(mdPath)) return null;
  return readFileSync(mdPath, 'utf-8');
}

export function getRegistryAddonConfig(homeDir: string, name: string): RegistryAddonConfig {
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(`Invalid addon name: ${name}`);
  }

  // Overlay-only addons (compose.yml only, no .env.schema) have no env vars
  // to render, so the schema reads as an empty string.
  const schemaPath = `state/registry/addons/${name}/.env.schema`;
  const schemaFile = join(homeDir, schemaPath);
  return {
    schemaPath,
    userEnvPath: 'config/stack/stack.env',
    envSchema: existsSync(schemaFile) ? readFileSync(schemaFile, 'utf-8') : '',
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
  const addonsDir = join(homeDir, 'config', 'stack', 'addons');
  if (!existsSync(addonsDir)) return [];

  return readdirSync(addonsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(addonsDir, entry.name, 'compose.yml')))
    .map((entry) => entry.name)
    .sort();
}

function copyAddonFromRegistry(homeDir: string, name: string): void {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);

  const sourceDir = join(resolveRegistryAddonsDir(), name);
  // compose.yml is the only required file. Overlay-only addons may omit
  // .env.schema entirely.
  if (!existsSync(join(sourceDir, 'compose.yml'))) {
    throw new Error(`Addon "${name}" not found in registry`);
  }

  const targetDir = join(homeDir, 'config', 'stack', 'addons', name);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(join(homeDir, 'config', 'stack', 'addons'), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
}

function removeEnabledAddon(homeDir: string, name: string): void {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
  rmSync(join(homeDir, 'config', 'stack', 'addons', name), { recursive: true, force: true });
}

function readAddonServiceNames(composePath: string): string[] {
  if (!existsSync(composePath)) return [];

  try {
    const parsed = parseYaml(readFileSync(composePath, "utf-8"));
    const services = parsed && typeof parsed === "object" ? (parsed as { services?: unknown }).services : undefined;
    if (!services || typeof services !== "object" || Array.isArray(services)) return [];
    return Object.keys(services as Record<string, unknown>);
  } catch (error) {
    logger.warn("failed to parse addon compose services", {
      composePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export function getAddonServiceNames(homeDir: string, name: string): string[] {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);

  const composeCandidates = [
    join(homeDir, "config", "stack", "addons", name, "compose.yml"),
    join(homeDir, "state", "registry", "addons", name, "compose.yml"),
  ];

  for (const composePath of composeCandidates) {
    const services = readAddonServiceNames(composePath);
    if (services.length > 0) return services;
  }

  return [];
}

export type AddonProfile = {
  id: string;
  services: string[];
  label?: string;
  requires?: string;
  default?: boolean;
  /**
   * Whether the host can run this profile.
   *
   * Populated by `getAddonProfileAvailability()`. When the value is missing
   * (e.g. older catalogs), callers should treat the profile as available.
   */
  available?: boolean;
  /** Human-readable reason when `available === false`. */
  reason?: string;
};

// ── Host capability probes ─────────────────────────────────────────────

export type AddonProfileAvailability = { available: boolean; reason?: string };

const HOST_PROBE_TIMEOUT_MS = 2_000;

// Process-lifetime cache. Hardware presence does not change while the UI
// server is running, so probing once is enough.
const availabilityCache = new Map<string, AddonProfileAvailability>();

/**
 * Reset the host-capability cache. Test-only — not exported.
 */
function _resetAvailabilityCacheForTests(): void {
  availabilityCache.clear();
}

// Exported under a deliberately ugly name so test files can reach it.
export const __addonAvailabilityTestHooks = {
  reset: _resetAvailabilityCacheForTests,
  /**
   * Test-only: exposes the internal exec wrapper so tests can verify
   * ENOENT (missing binary) is surfaced as actionable stderr that the
   * docker-error translator can recognise.
   */
  execFileNoThrow: (cmd: string, args: string[], timeoutMs: number) =>
    execFileNoThrow(cmd, args, timeoutMs),
};

function execFileNoThrow(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      // ENOENT (binary missing) surfaces here with no stderr — child_process
      // never gets to exec the program. Inject a synthetic stderr that
      // matches the translateDockerError ENOENT regex so callers get
      // actionable copy instead of "unknown error (no stderr)".
      let mergedStderr = stderr?.toString() ?? '';
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code && !mergedStderr) {
        if (code === 'ENOENT') {
          mergedStderr = `spawn ${cmd} ENOENT: command not found`;
        } else {
          mergedStderr = `spawn ${cmd} ${code}`;
        }
      }
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? '',
        stderr: mergedStderr,
      });
    });
  });
}

/**
 * Compute the openpalm/voice image ref for a given GPU variant, matching
 * the substitution chain in the addon compose file:
 *   ${OP_IMAGE_NAMESPACE:-openpalm}/voice:${OP_VOICE_IMAGE_TAG:-${OP_IMAGE_TAG:-v0.11.0}-<variant>}
 */
function voiceImageRef(variant: 'cpu' | 'cu121' | 'rocm6'): string {
  const namespace = process.env.OP_IMAGE_NAMESPACE?.trim() || 'openpalm';
  const explicit = process.env.OP_VOICE_IMAGE_TAG?.trim();
  if (explicit) return `${namespace}/voice:${explicit}`;
  const baseTag = process.env.OP_IMAGE_TAG?.trim() || 'v0.11.0';
  return `${namespace}/voice:${baseTag}-${variant}`;
}

/**
 * `docker manifest inspect <ref>` returns 0 only when the registry can
 * resolve a manifest for that ref. We use it as the cheap "is this image
 * actually published?" check — no pull required. The retry handles
 * transient registry hiccups. Timeout is short because the manifest blob
 * is a few KB.
 */
async function dockerManifestExists(imageRef: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await execFileNoThrow(
      'docker',
      ['manifest', 'inspect', imageRef],
      5_000,
    );
    if (res.ok) return true;
    // If docker itself is missing (ENOENT), retrying won't help.
    if (/ENOENT/.test(res.stderr)) return false;
  }
  return false;
}

async function probeCuda(): Promise<AddonProfileAvailability> {
  // Two acceptance signals:
  //   1. `docker info` reports an `nvidia` runtime (toolkit installed +
  //      `nvidia-ctk runtime configure --runtime=docker` was run).
  //   2. `/etc/cdi/nvidia.yaml` exists (CDI-mode daemon with a generated
  //      spec). We don't require the runtime in this case — the route's
  //      CDI fallback can switch the compose to driver:cdi.
  try {
    if (existsSync('/etc/cdi/nvidia.yaml')) return { available: true };
  } catch {
    // existsSync only throws on path-syntax issues; ignore and probe docker.
  }

  const result = await execFileNoThrow(
    'docker',
    ['info', '--format', '{{json .Runtimes}}'],
    HOST_PROBE_TIMEOUT_MS,
  );
  if (result.ok && result.stdout.includes('"nvidia"')) {
    return { available: true };
  }
  return {
    available: false,
    reason: 'NVIDIA runtime not registered. Install nvidia-container-toolkit or enable CDI.',
  };
}

async function probeRocm(): Promise<AddonProfileAvailability> {
  // Hardware gate: ROCm needs both the KFD char device and the GPU DRI nodes.
  let devicesPresent = false;
  try {
    devicesPresent = existsSync('/dev/kfd') && existsSync('/dev/dri');
  } catch {
    devicesPresent = false;
  }
  if (!devicesPresent) {
    return {
      available: false,
      reason: 'AMD ROCm devices not present on this host.',
    };
  }

  // Image gate: the openpalm/voice:*-rocm6 image isn't published yet, so
  // even on a fully-functional ROCm host the compose-up would fail with a
  // manifest-unknown pull error. Refuse the profile until the image lands.
  const imageRef = voiceImageRef('rocm6');
  const published = await dockerManifestExists(imageRef);
  if (!published) {
    return {
      available: false,
      reason: 'AMD ROCm image not published yet. Check back in a future release or use the CPU profile.',
    };
  }
  return { available: true };
}

/**
 * Probe the host for the capabilities required by an addon profile.
 *
 * Results are cached for the lifetime of the process — hardware doesn't
 * change while the UI server runs. All probes use execFile (no shell)
 * and never throw: errors collapse to `{ available: false, reason }`.
 *
 * Unknown profile ids default to `available: true` so unrelated addons
 * (e.g. a future "high-mem" profile that doesn't probe hardware) keep
 * working without code changes here.
 */
export async function getAddonProfileAvailability(
  profile: Pick<AddonProfile, 'id'>,
): Promise<AddonProfileAvailability> {
  const cacheKey = profile.id;
  const cached = availabilityCache.get(cacheKey);
  if (cached) return cached;

  let result: AddonProfileAvailability;
  try {
    if (profile.id === 'cpu') {
      result = { available: true };
    } else if (profile.id === 'cuda') {
      result = await probeCuda();
    } else if (profile.id === 'rocm') {
      result = await probeRocm();
    } else {
      // Unknown profile id — assume available; caller is responsible for
      // labelling profiles that need host capability gating.
      result = { available: true };
    }
  } catch (err) {
    // Belt-and-braces: any unexpected throw collapses to unavailable.
    const reason = err instanceof Error ? err.message : String(err);
    result = { available: false, reason: `probe failed: ${reason}` };
  }

  availabilityCache.set(cacheKey, result);
  return result;
}

/**
 * Decorate a list of profiles with `available`/`reason` based on the host
 * capability probes. Returns a fresh array; does not mutate inputs.
 */
export async function annotateAddonProfileAvailability(
  profiles: AddonProfile[],
): Promise<AddonProfile[]> {
  const results = await Promise.all(
    profiles.map(async (p) => {
      const a = await getAddonProfileAvailability(p);
      const annotated: AddonProfile = { ...p, available: a.available };
      if (a.reason) annotated.reason = a.reason;
      return annotated;
    }),
  );
  return results;
}

function readAddonProfiles(composePath: string): AddonProfile[] {
  if (!existsSync(composePath)) return [];

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(composePath, "utf-8"));
  } catch (error) {
    logger.warn("failed to parse addon compose profiles", {
      composePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const services = parsed && typeof parsed === "object"
    ? (parsed as { services?: unknown }).services
    : undefined;
  if (!services || typeof services !== "object" || Array.isArray(services)) return [];

  const byProfile = new Map<string, AddonProfile>();
  for (const [svcName, svcRaw] of Object.entries(services as Record<string, unknown>)) {
    if (!svcRaw || typeof svcRaw !== "object") continue;
    const svc = svcRaw as { profiles?: unknown; labels?: unknown };
    if (!Array.isArray(svc.profiles)) continue;
    const profileIds = svc.profiles.filter((p): p is string => typeof p === "string");
    if (profileIds.length === 0) continue;

    const labels = readServiceLabels(svc.labels);
    const label = labels["openpalm.profile.label"];
    const requires = labels["openpalm.profile.requires"];
    const isDefault = labels["openpalm.profile.default"] === "true";

    for (const id of profileIds) {
      const existing = byProfile.get(id);
      if (existing) {
        existing.services.push(svcName);
        if (!existing.label && label) existing.label = label;
        if (!existing.requires && requires) existing.requires = requires;
        if (!existing.default && isDefault) existing.default = true;
      } else {
        const profile: AddonProfile = { id, services: [svcName] };
        if (label) profile.label = label;
        if (requires) profile.requires = requires;
        if (isDefault) profile.default = true;
        byProfile.set(id, profile);
      }
    }
  }

  return [...byProfile.values()];
}

function readServiceLabels(raw: unknown): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq < 0) continue;
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = String(v);
    }
  }
  return out;
}

export function getAddonProfiles(homeDir: string, name: string): AddonProfile[] {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);

  const composeCandidates = [
    join(homeDir, "config", "stack", "addons", name, "compose.yml"),
    join(homeDir, "state", "registry", "addons", name, "compose.yml"),
  ];

  for (const composePath of composeCandidates) {
    const profiles = readAddonProfiles(composePath);
    if (profiles.length > 0) return profiles;
  }

  return [];
}

function profileEnvKey(name: string): string {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
  return `OP_${name.replace(/-/g, '_').toUpperCase()}_PROFILE`;
}

export function getAddonProfileSelection(stackDir: string, name: string): string | null {
  const env = readStackEnv(stackDir);
  const value = env[profileEnvKey(name)];
  return value && value.trim() ? value.trim() : null;
}

export function setAddonProfileSelection(stackDir: string, name: string, profile: string): void {
  const trimmed = profile.trim();
  if (!trimmed) throw new Error('Profile id cannot be empty');
  patchSecretsEnvFile(stackDir, { [profileEnvKey(name)]: trimmed });
}

function enableAddon(homeDir: string, name: string): MutationResult {
  try {
    copyAddonFromRegistry(homeDir, name);
    // Pre-create the addon services directory so Docker doesn't create it as root
    mkdirSync(join(homeDir, 'services', name), { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function disableAddonByName(homeDir: string, name: string): MutationResult {
  try {
    removeEnabledAddon(homeDir, name);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function setAddonEnabled(homeDir: string, stackDir: string, name: string, enabled: boolean): AddonMutationResult {
  if (!VALID_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid addon name: ${name}` };
  }

  if (!listAvailableAddonIds().includes(name)) {
    return { ok: false, error: `Addon "${name}" not found in registry` };
  }

  const wasEnabled = listEnabledAddonIds(homeDir).includes(name);
  const services = getAddonServiceNames(homeDir, name);

  if (wasEnabled === enabled) {
    return {
      ok: true,
      enabled: wasEnabled,
      changed: false,
      services,
    };
  }

  const mutation = enabled ? enableAddon(homeDir, name) : disableAddonByName(homeDir, name);
  if (!mutation.ok) return mutation;

  if (enabled) {
    const composePath = join(homeDir, "config", "stack", "addons", name, "compose.yml");
    if (isChannelAddon(composePath)) {
      writeChannelSecrets(stackDir, { [name]: randomHex(16) });
    }
  }

  return {
    ok: true,
    enabled,
    changed: true,
    services,
  };
}

export function installAutomationFromRegistry(name: string, stashDir: string): MutationResult {
  if (!VALID_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid automation name: ${name}` };
  }

  const markdownContent = getRegistryAutomation(name);
  if (!markdownContent) {
    return { ok: false, error: `Automation "${name}" not found in registry` };
  }

  const tasksDir = join(stashDir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  const mdPath = join(tasksDir, `${name}.md`);
  if (existsSync(mdPath)) {
    return { ok: false, error: `Automation "${name}" is already installed` };
  }

  writeFileSync(mdPath, markdownContent);
  // The assistant container's 60-second akm tasks sync loop picks up the new
  // file from the shared stash mount and registers it with OS cron.
  return { ok: true };
}

export function uninstallAutomation(name: string, stashDir: string): MutationResult {
  if (!VALID_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid automation name: ${name}` };
  }

  const mdPath = join(stashDir, 'tasks', `${name}.md`);
  if (!existsSync(mdPath)) {
    return { ok: false, error: `Automation "${name}" is not installed` };
  }

  rmSync(mdPath, { force: true });
  // The assistant container's 60-second akm tasks sync will notice the file
  // is gone and deregister it from OS cron on next sync.
  return { ok: true };
}
