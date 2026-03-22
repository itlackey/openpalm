/**
 * Path resolution — re-exports from @openpalm/lib with CLI-specific additions.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveConfigDir,
  resolveDataDir,
  resolveVaultDir,
  resolveOpenPalmHome,
} from '@openpalm/lib';

export const IS_WINDOWS = process.platform === 'win32';

// Re-export home layout resolvers
export { resolveConfigDir as defaultConfigDir };
export { resolveDataDir as defaultDataDir };
export { resolveVaultDir as defaultVaultDir };
export { resolveOpenPalmHome as defaultHomeDir };


// CLI-specific paths (not in lib)
export function defaultDockerSock(): string {
  if (process.env.OP_DOCKER_SOCK) return process.env.OP_DOCKER_SOCK;
  if (IS_WINDOWS) return '//./pipe/docker_engine';

  const home = homedir();
  const candidates = [
    '/var/run/docker.sock',
    join(home, '.orbstack/run/docker.sock'),
    join(home, '.colima/default/docker.sock'),
    join(home, '.rd/docker.sock'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export function defaultWorkDir(): string {
  return process.env.OP_WORK_DIR || `${resolveDataDir()}/workspace`;
}
