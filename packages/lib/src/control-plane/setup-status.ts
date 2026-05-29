import { parseEnvFile } from './env.js';

/**
 * Check if setup is complete by reading config/stack/stack.env.
 *
 * Only OP_SETUP_COMPLETE=true is authoritative. Secrets live in
 * config/stack/secrets and are not completion sentinels.
 */
export function isSetupComplete(stackDir: string): boolean {
  const parsed = parseEnvFile(`${stackDir}/stack.env`);
  return parsed.OP_SETUP_COMPLETE === "true";
}
