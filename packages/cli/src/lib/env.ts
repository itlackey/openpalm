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
 * Ensures vault/user exists. Phase 2 of #388 (closes #406): the
 * `user.env` file is no longer seeded — user-managed env secrets live in
 * the akm `vault:user` store and are sourced by the assistant entrypoint
 * directly. The directory itself is still created because operational
 * files (apprise.yml, gcloud creds, gws/mgc auth dirs) bind-mount from
 * here into the assistant container at /etc/vault/.
 */
export async function ensureSecrets(vaultDir: string): Promise<void> {
  mkdirSync(join(vaultDir, 'user'), { recursive: true });
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
