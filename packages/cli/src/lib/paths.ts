import { homedir } from 'node:os';
import { join } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

export function defaultConfigHome(): string {
  if (process.env.OPENPALM_CONFIG_HOME) return process.env.OPENPALM_CONFIG_HOME;
  if (IS_WINDOWS) {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'openpalm');
  }
  return join(homedir(), '.config', 'openpalm');
}

export function defaultDataHome(): string {
  if (process.env.OPENPALM_DATA_HOME) return process.env.OPENPALM_DATA_HOME;
  if (IS_WINDOWS) {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'openpalm', 'data');
  }
  return join(homedir(), '.local', 'share', 'openpalm');
}

export function defaultStateHome(): string {
  if (process.env.OPENPALM_STATE_HOME) return process.env.OPENPALM_STATE_HOME;
  if (IS_WINDOWS) {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'openpalm', 'state');
  }
  return join(homedir(), '.local', 'state', 'openpalm');
}

export function defaultDockerSock(): string {
  if (process.env.OPENPALM_DOCKER_SOCK) return process.env.OPENPALM_DOCKER_SOCK;
  return IS_WINDOWS ? '//./pipe/docker_engine' : '/var/run/docker.sock';
}

export function defaultWorkDir(): string {
  return process.env.OPENPALM_WORK_DIR || join(homedir(), 'openpalm');
}
