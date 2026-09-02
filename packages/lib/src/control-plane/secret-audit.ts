import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, normalize, resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseEnvContent, parseEnvFile } from './env.js';
import { isSecretLikeKey } from './secrets.js';
// The audit's job is to verify exactly what preparePaperclipAddon wrote, so it
// shares that module's key set and path helper rather than keeping copies that
// could drift apart.
import { PAPERCLIP_ENV_KEYS, paperclipEnvFile } from './paperclip.js';
// The audit must agree with the writer about which secrets live in
// state/secrets/ — the writer routes default-deny, so the agent-readable
// allowlist is the whole rule.
import { isAgentReadableSecretName } from './secrets-files.js';

export { isSecretLikeKey };

export type SecretAuditSeverity = 'error' | 'warning';

export type SecretAuditIssue = {
  severity: SecretAuditSeverity;
  code: string;
  message: string;
  path?: string;
};

export type SecretAuditResult = {
  ok: boolean;
  issues: SecretAuditIssue[];
};

export type SecretAuditOptions = {
  stackEnvPath?: string;
  stackEnvContent?: string;
  composeConfig?: string | unknown;
  secretsDir?: string;
  stateSecretsDir?: string;
  homeDir?: string;
};

type ComposeService = {
  image?: unknown;
  env_file?: unknown;
  environment?: unknown;
  secrets?: unknown;
  networks?: unknown;
  volumes?: unknown;
};

type ComposeConfig = {
  services?: Record<string, ComposeService>;
  secrets?: Record<string, unknown>;
};

const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

function issue(code: string, message: string, path?: string): SecretAuditIssue {
  return { severity: 'error', code, message, path };
}

function parseComposeConfig(input: string | unknown): ComposeConfig {
  if (typeof input === 'string') {
    const parsed = parseYaml(input) as unknown;
    return isRecord(parsed) ? parsed as ComposeConfig : {};
  }
  return isRecord(input) ? input as ComposeConfig : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function environmentEntries(environment: unknown): Array<[string, unknown]> {
  if (Array.isArray(environment)) {
    return environment.flatMap((entry) => {
      if (typeof entry !== 'string') return [];
      const eq = entry.indexOf('=');
      return eq > 0 ? [[entry.slice(0, eq), entry.slice(eq + 1)] as [string, string]] : [[entry, '']];
    });
  }
  if (isRecord(environment)) return Object.entries(environment);
  return [];
}

function serviceSecrets(secrets: unknown): string[] {
  if (!Array.isArray(secrets)) return [];
  return secrets.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!isRecord(entry)) return [];
    const source = entry.source ?? entry.target;
    return typeof source === 'string' ? [source] : [];
  });
}

function serviceSecretEntries(secrets: unknown): Array<{ source: string; target?: string }> {
  if (!Array.isArray(secrets)) return [];
  return secrets.flatMap((entry) => {
    if (typeof entry === 'string') return [{ source: entry }];
    if (!isRecord(entry) || typeof entry.source !== 'string') return [];
    return [{ source: entry.source, target: typeof entry.target === 'string' ? entry.target : undefined }];
  });
}

function volumeEntries(volumes: unknown): Array<{ type?: string; source?: string; target?: string }> {
  if (!Array.isArray(volumes)) return [];
  return volumes.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return [{
      type: typeof entry.type === 'string' ? entry.type : undefined,
      source: typeof entry.source === 'string' ? entry.source : undefined,
      target: typeof entry.target === 'string' ? entry.target : undefined,
    }];
  });
}

function serviceNetworks(networks: unknown): string[] {
  if (Array.isArray(networks)) return networks.filter((entry): entry is string => typeof entry === 'string');
  if (isRecord(networks)) return Object.keys(networks);
  return [];
}

function normalizedSecretName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isPortalService(name: string, service: ComposeService): boolean {
  const normalized = normalizedSecretName(name);
  if (normalized.startsWith('portal_')) return true;
  const image = typeof service.image === 'string' ? service.image.toLowerCase() : '';
  if (image.includes('/portal') || image.endsWith(':portal') || image.includes('openpalm/portal')) return true;
  return serviceNetworks(service.networks).includes('portal_net') && name !== 'guardian';
}

function allowedSecretForService(serviceName: string, service: ComposeService, secretName: string): boolean {
  const serviceId = normalizedSecretName(serviceName.replace(/^portal[-_]/i, ''));
  const secretId = normalizedSecretName(secretName);

  if (serviceName === 'assistant') {
    // ui_login_password ("One UI" Phase 4, PR #565 review): the assistant
    // container serves the @openpalm/ui co-process, which mints op_session
    // login cookies with the SAME UI login password as the host UI — the
    // route contract keeps /api/auth outside /api/host precisely so a served
    // non-admin deployment can authenticate. A deliberate single-secret
    // grant, mirroring guardian's opencode_server_password rule below.
    return (
      /^(assistant|opencode|provider|llm|embedding|akm|user)_/.test(secretId) ||
      secretId === 'ui_login_password'
    );
  }
  if (serviceName === 'guardian') {
    // op_api_key backs the guardian's OpenAI/Anthropic-compatible edge
    // (OPENAI_COMPAT_API_KEY_FILE) — a guardian-hosted credential, so it is a
    // legitimate grant to this service (S.1b).
    // opencode_server_password: the guardian attaches upstream Basic auth to
    // every assistant call (the assistant always requires one), so it must read
    // the same OpenCode server password the assistant serves — a legitimate
    // two-service grant (assistant already matches /^opencode_/).
    return (
      secretId.startsWith('guardian_') ||
      secretId.startsWith('portal_') ||
      secretId.startsWith('op_guardian_') ||
      secretId === 'op_api_key' ||
      secretId === 'opencode_server_password'
    );
  }
  if (serviceName === 'admin') {
    return /^(admin|ui|openpalm)_/.test(secretId);
  }
  if (serviceName === 'tunnel') {
    // ts_authkey is a tailnet JOIN credential, not a `tunnel_`-prefixed secret
    // — the naming convention the generic fallback below expects. tunnel also
    // sits on portal_net (the trust-boundary exception explained atop
    // services.compose.yml), which would otherwise make isPortalService() below
    // misclassify it as a portal adapter and require a
    // `portal_tunnel_`/`tunnel_` prefix it can never have. A single-secret
    // grant, same shape as guardian's op_api_key rule above.
    return secretId === 'ts_authkey';
  }
  if (isPortalService(serviceName, service)) {
    return secretId.startsWith(`portal_${serviceId}_`) || secretId.startsWith(`${serviceId}_`);
  }
  return secretId.startsWith(`${serviceId}_`);
}

export function auditStackEnv(env: Record<string, string>, label = 'stack.env'): SecretAuditIssue[] {
  const issues: SecretAuditIssue[] = [];
  for (const key of Object.keys(env)) {
    if (isSecretLikeKey(key)) {
      issues.push(issue(
        'stack-env-secret-key',
        `${label} must not contain secret-like key ${key}; store it as a narrowly granted file secret and expose ${key}_FILE, or, for a CLI/cron consumer that reads it from the environment (an akm engine, for example), put it in knowledge/env/user.env and invoke that command through \`akm env run user -- <command>\` — the assistant entrypoint does not source that file into any process.`,
        `${label}:${key}`,
      ));
    }
  }
  return issues;
}

export function auditComposeSecrets(
  composeConfig: string | unknown,
  options: { resolvedPaperclipEnv?: boolean } = {},
): SecretAuditIssue[] {
  const compose = parseComposeConfig(composeConfig);
  const issues: SecretAuditIssue[] = [];
  const topLevelSecrets = compose.secrets ?? {};
  for (const [name, definition] of Object.entries(topLevelSecrets)) {
    if (!isRecord(definition) || typeof definition.file !== 'string') {
      issues.push(issue('compose-secret-source', `top-level secret ${name} must use a file source.`, `secrets.${name}`));
    }
  }
  for (const [serviceName, service] of Object.entries(compose.services ?? {})) {
    if (
      service.env_file !== undefined &&
      !isPaperclipEnvFile(serviceName, service.env_file, options.resolvedPaperclipEnv === true)
    ) {
      issues.push(issue(
        'compose-service-env-file',
        `service ${serviceName} must not use env_file; pass non-secrets explicitly and use Docker secrets for secret values.`,
        `services.${serviceName}.env_file`,
      ));
    }

    const grantedSecrets = new Set(serviceSecrets(service.secrets));
    for (const [key, value] of environmentEntries(service.environment)) {
      if (
        isSecretLikeKey(key) &&
        !(options.resolvedPaperclipEnv && serviceName === 'paperclip' && PAPERCLIP_ENV_KEYS.has(key))
      ) {
        issues.push(issue(
          'compose-secret-env-var',
          `service ${serviceName} environment key ${key} is secret-like; expose only ${key}_FILE, or, for a CLI/cron consumer that reads it from the environment (an akm engine, for example), put it in knowledge/env/user.env and invoke that command through \`akm env run user -- <command>\` — the assistant entrypoint does not source that file into any process.`,
          `services.${serviceName}.environment.${key}`,
        ));
      }
      if (Object.keys(topLevelSecrets).length > 0 && key.endsWith('_FILE') && typeof value === 'string' && !value.includes('${')) {
        const referenced = value.startsWith('/run/secrets/') ? basename(value) : '';
        if (!referenced || value !== `/run/secrets/${referenced}` || !grantedSecrets.has(referenced)) {
          issues.push(issue(
            'compose-secret-env-redirection',
            `service ${serviceName} environment ${key} must reference a secret granted to that service by its declared name.`,
            `services.${serviceName}.environment.${key}`,
          ));
        }
      }
    }

    for (const secretName of serviceSecrets(service.secrets)) {
      if (Object.keys(topLevelSecrets).length > 0 && !(secretName in topLevelSecrets)) {
        issues.push(issue('compose-secret-undefined', `service ${serviceName} references undefined secret ${secretName}.`, `services.${serviceName}.secrets`));
      }
      if (!allowedSecretForService(serviceName, service, secretName)) {
        issues.push(issue(
          'compose-secret-boundary',
          `service ${serviceName} is not allowed to mount secret ${secretName}.`,
          `services.${serviceName}.secrets`,
        ));
      }
    }

    for (const entry of serviceSecretEntries(service.secrets)) {
      if (entry.target && basename(entry.target) !== normalizedSecretName(entry.source)) {
        issues.push(issue(
          'compose-secret-redirection',
          `service ${serviceName} redirects secret ${entry.source} to ${entry.target}; secret targets must retain their declared name.`,
          `services.${serviceName}.secrets`,
        ));
      }
    }

    for (const volume of volumeEntries(service.volumes)) {
      // state/ as a whole IS bind-mounted (the tunnel reads state/remote/), so
      // this names the two credential subtrees rather than the tree: they are
      // handed to containers as named Compose secrets and as paperclip's single
      // audited env_file, never as a mount.
      if (volume.type === 'bind' && volume.source && /(?:^|[\\/])state[\\/](?:secrets|env)(?:[\\/]|$)/i.test(normalize(volume.source))) {
        issues.push(issue(
          'compose-credential-bind-mount',
          `service ${serviceName} must not bind-mount state/secrets/ or state/env/; delegated credentials are named Compose secrets only.`,
          `services.${serviceName}.volumes`,
        ));
      }
    }
  }
  return issues;
}

function isPaperclipEnvFile(serviceName: string, envFile: unknown, resolved: boolean): boolean {
  if (serviceName !== 'paperclip') return false;
  const entries = Array.isArray(envFile) ? envFile : [envFile];
  if (entries.length !== 1 || typeof entries[0] !== 'string') return false;
  return resolved
    ? /[\\/]state[\\/]env[\\/]paperclip\.env$/.test(entries[0])
    : entries[0] === '${OP_HOME:?}/state/env/paperclip.env';
}

/**
 * Audit the resolved Paperclip env file. Returns the FIRST problem found, or
 * undefined when clean — a single issue rather than an array, because every
 * check short-circuits and an array return advertised a multi-issue contract
 * this never had.
 */
function auditPaperclipEnv(service: ComposeService, homeDir: string): SecretAuditIssue | undefined {
  const expected = resolve(paperclipEnvFile(homeDir));
  if (service.env_file !== undefined) {
    const entries = Array.isArray(service.env_file) ? service.env_file : [service.env_file];
    if (entries.length !== 1 || typeof entries[0] !== 'string' || resolve(entries[0]) !== expected) {
      return issue(
        'paperclip-env-file-boundary',
        `service paperclip may use only ${expected} as its single env_file.`,
        'services.paperclip.env_file',
      );
    }
  }
  // The ENOENT throw IS the existence check — one stat instead of two.
  let fileStat: ReturnType<typeof lstatSync>;
  try {
    fileStat = lstatSync(expected);
  } catch {
    return issue('paperclip-env-file-missing', `Paperclip env file does not exist: ${expected}`, expected);
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    return issue('paperclip-env-file-type', `Paperclip env file must be a regular file: ${expected}`, expected);
  }
  if ((fileStat.mode & 0o777) !== SECRET_FILE_MODE) {
    return issue('paperclip-env-file-mode', `Paperclip env file must be 0600, got ${formatMode(fileStat.mode)}.`, expected);
  }
  const envDir = dirname(expected);
  if ((statSync(envDir).mode & 0o777) !== SECRET_DIR_MODE) {
    return issue('paperclip-env-dir-mode', `Paperclip env directory must be 0700: ${envDir}`, envDir);
  }

  const env = parseEnvFile(expected);
  const invalid = Object.keys(env).filter((key) => !PAPERCLIP_ENV_KEYS.has(key));
  if (invalid.length > 0) {
    return issue('paperclip-env-key-boundary', `Paperclip env_file contains unsupported key(s): ${invalid.join(', ')}.`, expected);
  }
  const missing = [...PAPERCLIP_ENV_KEYS].filter((key) => !env[key]);
  if (missing.length > 0) {
    return issue('paperclip-env-key-missing', `Paperclip env_file is missing required key(s): ${missing.join(', ')}.`, expected);
  }
  // `compose config` inlines env_file into environment, so an EQUAL value here
  // is expected; only a DIFFERING value means the compose block overrode the
  // audited file.
  for (const [key, value] of environmentEntries(service.environment)) {
    if (PAPERCLIP_ENV_KEYS.has(key) && String(value) !== env[key]) {
      return issue(
        'paperclip-env-value-boundary',
        `service paperclip environment ${key} must come from ${expected}.`,
        `services.paperclip.environment.${key}`,
      );
    }
  }
  return undefined;
}

export function auditResolvedComposeSecrets(
  composeConfig: string | unknown,
  options: { homeDir?: string } = {},
): SecretAuditIssue[] {
  const compose = parseComposeConfig(composeConfig);
  const home = options.homeDir ? resolve(options.homeDir) : undefined;
  const issues = auditComposeSecrets(compose, { resolvedPaperclipEnv: Boolean(home) });
  if (home && compose.services?.paperclip) {
    const paperclipIssue = auditPaperclipEnv(compose.services.paperclip, home);
    if (paperclipIssue) issues.push(paperclipIssue);
  }
  for (const [name, definition] of Object.entries(compose.secrets ?? {})) {
    if (!isRecord(definition) || typeof definition.file !== 'string' || !home) continue;
    const source = resolve(definition.file);
    // Routed on the FILENAME the source must have, not the compose secret name:
    // the alias map below is what turns `guardian_auth_json` into `auth.json`,
    // the one agent-readable file.
    const filename = expectedSecretFilename(name);
    const expectedRoot = isAgentReadableSecretName(filename)
      ? resolve(home, 'knowledge', 'secrets')
      : resolve(home, 'state', 'secrets');
    const expected = resolve(expectedRoot, filename);
    if (source !== expected) {
      issues.push(issue(
        'compose-secret-source-boundary',
        `top-level secret ${name} must source exactly ${expected}; secret-name aliases and redirection are forbidden.`,
        `secrets.${name}.file`,
      ));
    }
  }
  return issues;
}

function expectedSecretFilename(name: string): string {
  if (name === 'opencode_server_password') return 'op_opencode_password';
  if (name === 'ui_login_password') return 'op_ui_login_password';
  if (name === 'guardian_auth_json') return 'auth.json';
  return name;
}

export function auditSecretFilesystem(secretsDir: string): SecretAuditIssue[] {
  const issues: SecretAuditIssue[] = [];
  if (!existsSync(secretsDir)) {
    issues.push(issue('secrets-dir-missing', `secrets directory does not exist: ${secretsDir}`, secretsDir));
    return issues;
  }

  const dirStat = statSync(secretsDir);
  if (!dirStat.isDirectory()) {
    issues.push(issue('secrets-dir-not-directory', `secrets path is not a directory: ${secretsDir}`, secretsDir));
    return issues;
  }
  if ((dirStat.mode & 0o777) !== SECRET_DIR_MODE) {
    issues.push(issue('secrets-dir-mode', `secrets directory must be 0700, got ${formatMode(dirStat.mode)}.`, secretsDir));
  }

  for (const entry of readdirSync(secretsDir, { withFileTypes: true })) {
    const path = join(secretsDir, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push(issue('secret-symlink', 'secret directories and files must not be symbolic links.', path));
      continue;
    }
    if (entry.isDirectory()) {
      issues.push(...auditSecretFilesystem(path));
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = lstatSync(path);
    if ((fileStat.mode & 0o777) !== SECRET_FILE_MODE) {
      issues.push(issue('secret-file-mode', `secret file must be 0600, got ${formatMode(fileStat.mode)}.`, path));
    }
  }
  return issues;
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

export function auditFileBasedSecrets(options: SecretAuditOptions): SecretAuditResult {
  const issues: SecretAuditIssue[] = [];

  if (options.stackEnvContent !== undefined) {
    issues.push(...auditStackEnv(parseEnvContent(options.stackEnvContent), 'stack.env'));
  } else if (options.stackEnvPath) {
    issues.push(...auditStackEnv(parseEnvFile(options.stackEnvPath), options.stackEnvPath));
  }

  if (options.composeConfig !== undefined) {
    issues.push(...(options.homeDir
      ? auditResolvedComposeSecrets(options.composeConfig, { homeDir: options.homeDir })
      : auditComposeSecrets(options.composeConfig)));
  }

  if (options.secretsDir) {
    issues.push(...auditSecretFilesystem(options.secretsDir));
  }
  if (options.stateSecretsDir) {
    issues.push(...auditSecretFilesystem(options.stateSecretsDir));
  }

  return { ok: issues.length === 0, issues };
}
