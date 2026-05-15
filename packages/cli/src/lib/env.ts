import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { reconcileStackEnvImageTag, resolveRequestedImageTag } from '@openpalm/lib';
import { defaultDockerSock } from './paths.ts';

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
