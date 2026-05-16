import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { reconcileStackEnvImageTag, resolveRequestedImageTag } from '@openpalm/lib';
import { defaultDockerSock } from './paths.ts';

/**
 * Ensures the state/ directory exists.
 * User-managed env secrets live in the akm `vault:user` store and are sourced
 * by the assistant entrypoint directly.
 */
export async function ensureSecrets(stateDir: string): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
}

/**
 * Creates or updates the config/stack/stack.env bootstrap file.
 *
 * When `imageTagOverride` is provided (e.g. derived from --version during
 * install), it takes precedence over both the OP_IMAGE_TAG env var
 * and the repo-ref heuristic. This prevents stale or architecture-suffixed
 * env vars (e.g. "latest-arm64") from leaking into the stack.
 */
export async function ensureStackEnv(
  homeDir: string,
  configDir: string,
  workDir: string,
  repoRef: string,
  imageTagOverride?: string,
): Promise<void> {
  const stackDir = join(configDir, 'stack');
  const systemEnvPath = join(stackDir, 'stack.env');
  const explicitImageTag = imageTagOverride ?? process.env.OP_IMAGE_TAG;
  const hasExplicitImageTag = explicitImageTag !== undefined && explicitImageTag !== '';
  mkdirSync(stackDir, { recursive: true });
  if (!(await Bun.file(systemEnvPath).exists())) {
    const defaultImageTag = hasExplicitImageTag
      ? explicitImageTag
      : (resolveRequestedImageTag(repoRef) || 'latest');
    const content = `# OpenPalm System Environment — system-managed, do not edit
OP_HOME=${homeDir}
OP_WORK_DIR=${workDir}
OP_UID=${process.getuid?.() ?? 1000}
OP_GID=${process.getgid?.() ?? 1000}
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
