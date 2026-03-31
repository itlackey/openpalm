import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { defaultDockerSock } from './paths.ts';

export function unwrapQuotedEnvValue(value: string): string {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
  const isSingleQuoted = value.startsWith('\'') && value.endsWith('\'');
  if ((isDoubleQuoted || isSingleQuoted) && value.length >= 2) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * Upserts a key=value pair in env file content. If the key exists, replaces the line;
 * otherwise appends a new line.
 */
export function upsertEnvValue(content: string, key: string, value: string): string {
  const escapedKey = key.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  const pattern = new RegExp(`^((?:export\\s+)?)${escapedKey}=.*$`, 'm');
  if (pattern.test(content)) {
    // Preserve the `export ` prefix if the original line had one
    return content.replace(pattern, `$1${key}=${value}`);
  }

  const line = `${key}=${value}`;
  const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  return `${content}${suffix}${line}\n`;
}

export const RELEASE_TAG_REGEX = /^v?\d+\.\d+\.\d+(?:[-+](?:[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

/**
 * Normalizes a repository ref to an image tag. Returns null for non-release refs.
 * E.g. "0.9.0" → "v0.9.0", "v0.9.0" → "v0.9.0", "main" → null.
 */
export function resolveRequestedImageTag(repoRef: string): string | null {
  const trimmed = repoRef.trim();
  if (!trimmed || trimmed === 'main') return null;
  if (!RELEASE_TAG_REGEX.test(trimmed)) return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * Reconciles the OP_IMAGE_TAG value in stack.env content.
 */
export function reconcileStackEnvImageTag(
  content: string,
  repoRef: string,
  explicitImageTag?: string,
): string {
  const desiredImageTag = explicitImageTag || resolveRequestedImageTag(repoRef);
  if (!desiredImageTag) return content;
  return upsertEnvValue(content, 'OP_IMAGE_TAG', desiredImageTag);
}

/**
 * Seeds vault/user/user.env with initial template.
 * Uses `export` prefix so the file can be sourced in a shell and is still
 * compatible with Docker Compose v2 `env_file`.
 * Contains user-managed secrets only (API keys, memory user ID).
 * System secrets (OP_ADMIN_TOKEN, OP_ASSISTANT_TOKEN, OP_MEMORY_TOKEN)
 * live in vault/stack/stack.env and are managed by the control plane.
 */
export async function ensureSecrets(vaultDir: string): Promise<void> {
  const secretsPath = join(vaultDir, 'user', 'user.env');
  if (await Bun.file(secretsPath).exists()) {
    return;
  }

  mkdirSync(join(vaultDir, 'user'), { recursive: true });
  // user.env is for user-added custom env vars only.
  // All standard secrets (API keys, tokens) live in stack.env.
  // Do NOT put API key placeholders here — user.env is loaded after
  // stack.env by Docker Compose, so empty values would override real keys.
  const content = `# OpenPalm — User Extensions
# Add any custom environment variables here.
# These are loaded by compose alongside stack.env.
`;

  await Bun.write(secretsPath, content);
}

/**
 * Creates or updates the vault/stack/stack.env bootstrap file.
 *
 * When `imageTagOverride` is provided (e.g. derived from --version during
 * install), it takes precedence over both the OP_IMAGE_TAG env var
 * and the repo-ref heuristic. This prevents stale or architecture-suffixed
 * env vars (e.g. "latest-arm64") from leaking into the stack.
 */
export async function ensureStackEnv(
  homeDir: string,
  vaultDir: string,
  workDir: string,
  repoRef: string,
  imageTagOverride?: string,
): Promise<void> {
  const systemEnvPath = join(vaultDir, 'stack', 'stack.env');
  const explicitImageTag = imageTagOverride ?? process.env.OP_IMAGE_TAG;
  const hasExplicitImageTag = explicitImageTag !== undefined && explicitImageTag !== '';
  mkdirSync(join(vaultDir, 'stack'), { recursive: true });
  if (!(await Bun.file(systemEnvPath).exists())) {
    const defaultImageTag = hasExplicitImageTag
      ? explicitImageTag
      : (resolveRequestedImageTag(repoRef) || 'latest');
    const content = `# OpenPalm System Environment — system-managed, do not edit
OP_HOME=${homeDir}
OP_WORK_DIR=${workDir}
OP_UID=${process.getuid?.() ?? 1000}
OP_GID=${process.getgid?.() ?? 1000}
OP_DOCKER_SOCK=${defaultDockerSock()}
OP_IMAGE_NAMESPACE=${process.env.OP_IMAGE_NAMESPACE || 'openpalm'}
OP_IMAGE_TAG=${defaultImageTag}
`;
    await Bun.write(systemEnvPath, content);
  } else {
    const current = await Bun.file(systemEnvPath).text();
    const reconciled = reconcileStackEnvImageTag(
      current,
      repoRef,
      hasExplicitImageTag ? explicitImageTag : undefined,
    );
    if (reconciled !== current) {
      await Bun.write(systemEnvPath, reconciled);
    }
  }
}
