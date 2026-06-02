import { parseEnvFile } from './env.js';
import { stackEnvPathFromStackDir } from './paths.js';

/**
 * Check if setup is complete by reading knowledge/env/stack.env.
 *
 * Only OP_SETUP_COMPLETE=true is authoritative. Secrets live in
 * knowledge/secrets and are not completion sentinels.
 */
export function isSetupComplete(stackDir: string): boolean {
  const parsed = parseEnvFile(stackEnvPathFromStackDir(stackDir));
  return parsed.OP_SETUP_COMPLETE === "true";
}
