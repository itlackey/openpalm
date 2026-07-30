import { spawnSync } from 'node:child_process';

/**
 * Terminate a process group (POSIX) or process tree (Windows).
 *
 * The UI child is spawned `detached` so it leads its own process group;
 * signalling the negative pid reaps it AND every descendant it spawned, which a
 * bare `process.kill(pid)` would orphan.
 *
 * Extracted from `local-opencode.ts` when the admin OpenCode child was deleted —
 * the UI supervisor's kill strategy is the remaining consumer.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* best effort */
    }
    return;
  }
  // Negative pid → the whole process group (the child is the group leader).
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* group gone or not a leader */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}
