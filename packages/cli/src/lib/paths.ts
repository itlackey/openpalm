/**
 * Path resolution — re-exports from @openpalm/lib with CLI-specific additions.
 */
import { resolveWorkspaceDir } from '@openpalm/lib';

// CLI-specific paths (not in lib)
export function defaultWorkDir(): string {
  return process.env.OP_WORK_DIR || resolveWorkspaceDir();
}
