import { parseEnvFile } from './env.js';
import { legacyStackEnvFile } from './home.js';

/**
 * Check if setup is complete by reading knowledge/env/stack.env.
 *
 * Only OP_SETUP_COMPLETE=true is authoritative. Secrets live in
 * knowledge/secrets and are not completion sentinels.
 */
export function isSetupComplete(homeDir: string): boolean {
  const parsed = parseEnvFile(legacyStackEnvFile(homeDir));
  return parsed.OP_SETUP_COMPLETE === "true";
}
