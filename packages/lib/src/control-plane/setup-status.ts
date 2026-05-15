import { parseEnvFile } from './env.js';

/**
 * Check if setup is complete by reading state/stack.env.
 */
export function isSetupComplete(stateDir: string): boolean {
  const parsed = parseEnvFile(`${stateDir}/stack.env`);
  if ("OP_SETUP_COMPLETE" in parsed) {
    return parsed.OP_SETUP_COMPLETE.toLowerCase() === "true";
  }

  return (parsed.OP_ADMIN_TOKEN ?? "").length > 0;
}
