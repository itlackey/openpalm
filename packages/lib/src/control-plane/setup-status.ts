import { parseEnvFile } from './env.js';

/**
 * Check if setup is complete by reading config/stack/stack.env.
 */
export function isSetupComplete(stackDir: string): boolean {
  const parsed = parseEnvFile(`${stackDir}/stack.env`);
  if ("OP_SETUP_COMPLETE" in parsed) {
    return parsed.OP_SETUP_COMPLETE.toLowerCase() === "true";
  }

  return (parsed.OP_ADMIN_TOKEN ?? "").length > 0;
}
