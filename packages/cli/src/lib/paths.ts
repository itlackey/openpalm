/**
 * Path resolution — re-exports from @openpalm/lib with CLI-specific additions.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveConfigHome,
  resolveDataHome,
  resolveStateHome,
} from '@openpalm/lib';

export const IS_WINDOWS = process.platform === 'win32';

// Re-export lib's XDG resolvers under CLI's existing names
export { resolveConfigHome as defaultConfigHome };
export { resolveDataHome as defaultDataHome };
export { resolveStateHome as defaultStateHome };

// CLI-specific paths (not in lib)
export function defaultDockerSock(): string {
  if (process.env.OPENPALM_DOCKER_SOCK) return process.env.OPENPALM_DOCKER_SOCK;
  return IS_WINDOWS ? '//./pipe/docker_engine' : '/var/run/docker.sock';
}

export function defaultWorkDir(): string {
  return process.env.OPENPALM_WORK_DIR || join(homedir(), 'openpalm');
}
