import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { reconcileStackEnvImageTag, resolveRequestedImageTag, resolveOperatorIds, hasUsableOperatorId } from '@openpalm/lib';
import { defaultDockerSock } from './paths.ts';

/**
 * Ensures the data/ directory exists.
 * User-managed env secrets live in the akm `vault:user` store and are sourced
 * by the assistant entrypoint directly.
 */
export async function ensureSecrets(dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
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
    const content = `# OpenPalm System Environment — system-managed, do not edit
OP_HOME=${homeDir}
OP_WORK_DIR=${workDir}
${idLines}OP_IMAGE_NAMESPACE=${process.env.OP_IMAGE_NAMESPACE || 'openpalm'}
OP_IMAGE_TAG=${defaultImageTag}
`;
    await Bun.write(systemEnvPath, content);
  } else {
    let current = await Bun.file(systemEnvPath).text();
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
