import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { reconcileStackEnvImageTag, resolveRequestedImageTag, resolveOperatorIds, hasUsableOperatorId } from '@openpalm/lib';
import { defaultDockerSock } from './paths.ts';

/**
 * Ensures the data/ directory exists.
 * User-managed env config lives in the akm `env:user` file and is sourced
 * by the assistant entrypoint directly.
 */
export async function ensureSecrets(dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
}

/**
 * Creates or updates the knowledge/env/stack.env bootstrap file.
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
  const envDir = join(homeDir, 'knowledge', 'env');
  const systemEnvPath = join(envDir, 'stack.env');
  const explicitImageTag = imageTagOverride ?? process.env.OP_IMAGE_TAG;
  const hasExplicitImageTag = explicitImageTag !== undefined && explicitImageTag !== '';
  mkdirSync(envDir, { recursive: true, mode: 0o700 });
  // Operator UID/GID — auto-detect from OP_HOME owner (or process UID).
  // Returns null on Windows; in that case we omit OP_UID/OP_GID and let
  // compose fall back to its `${OP_UID:-1000}` default (containers run
  // in WSL2 Linux where this doesn't matter).
  const ids = resolveOperatorIds(homeDir);
  if (!(await Bun.file(systemEnvPath).exists())) {
    const defaultImageTag = hasExplicitImageTag
      ? explicitImageTag
      : (resolveRequestedImageTag(repoRef) || 'latest');
    const idLines = ids ? `OP_UID=${ids.uid}\nOP_GID=${ids.gid}\n` : '';
    // Deterministic compose project name. Pinning it (vs. relying on the
    // "openpalm" fallback) keeps every install/start/down targeting the same
    // project, and lets dev seed a distinct value (openpalm-dev) so the two
    // stacks never collide. Mirrors scripts/dev-setup.sh.
    const projectName = process.env.OP_PROJECT_NAME?.trim() || 'openpalm';
    const content = `# OpenPalm System Environment — system-managed, do not edit
OP_HOME=${homeDir}
OP_WORK_DIR=${workDir}
OP_PROJECT_NAME=${projectName}
${idLines}OP_IMAGE_NAMESPACE=${process.env.OP_IMAGE_NAMESPACE || 'openpalm'}
OP_IMAGE_TAG=${defaultImageTag}
`;
    await Bun.write(systemEnvPath, content);
  } else {
    let current = await Bun.file(systemEnvPath).text();
    // Non-destructively backfill OP_PROJECT_NAME for installs predating it.
    if (!/^\s*OP_PROJECT_NAME\s*=/m.test(current)) {
      const projectName = process.env.OP_PROJECT_NAME?.trim() || 'openpalm';
      const next = (current.endsWith('\n') ? current : current + '\n') + `OP_PROJECT_NAME=${projectName}\n`;
      await Bun.write(systemEnvPath, next);
      current = next;
    }
    const reconciled = reconcileStackEnvImageTag(
      current,
      repoRef,
      hasExplicitImageTag ? explicitImageTag : undefined,
    );
    if (reconciled !== current) {
      await Bun.write(systemEnvPath, reconciled);
      current = reconciled;
    }

    // Backfill OP_UID/OP_GID for installs created by older CLI versions
    // that hard-coded 1000. Only fill missing/zero values — never override
    // a value the operator may have set explicitly.
    if (ids) {
      backfillOperatorIds(systemEnvPath, current, ids);
    }
  }
}

function readEnvKey(content: string, key: string): string | undefined {
  // Minimal key=value reader for OP_UID/OP_GID. Stack.env is system-managed
  // and these lines are always plain numerics (no quotes, no interpolation),
  // so this avoids pulling in a full env parser.
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm');
  const m = content.match(re);
  return m?.[1];
}

function backfillOperatorIds(
  path: string,
  current: string,
  ids: { uid: number; gid: number },
): void {
  const parsed: Record<string, string> = {};
  const uidValue = readEnvKey(current, 'OP_UID');
  const gidValue = readEnvKey(current, 'OP_GID');
  if (uidValue !== undefined) parsed.OP_UID = uidValue;
  if (gidValue !== undefined) parsed.OP_GID = gidValue;

  const patches: Array<[string, string]> = [];
  if (!hasUsableOperatorId(parsed, 'OP_UID')) patches.push(['OP_UID', String(ids.uid)]);
  if (!hasUsableOperatorId(parsed, 'OP_GID')) patches.push(['OP_GID', String(ids.gid)]);
  if (patches.length === 0) return;

  let next = current;
  for (const [key, value] of patches) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(next)) {
      next = next.replace(re, `${key}=${value}`);
    } else {
      next = (next.endsWith('\n') ? next : next + '\n') + `${key}=${value}\n`;
    }
  }
  if (next !== current) {
    writeFileSync(path, next);
  }
}
