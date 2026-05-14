import { parseEnvFile } from './env.js';

/**
 * Check if setup is complete by reading vault/stack/stack.env.
 */
export function isSetupComplete(vaultDir: string): boolean {
  const parsed = parseEnvFile(`${vaultDir}/stack/stack.env`);
  if ("OP_SETUP_COMPLETE" in parsed) {
    return parsed.OP_SETUP_COMPLETE.toLowerCase() === "true";
  }

  return (parsed.OP_ADMIN_TOKEN ?? "").length > 0;
}
