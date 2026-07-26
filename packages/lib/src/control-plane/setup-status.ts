import { parseEnvFile } from './env.js';
import { stackEnvFile } from './home.js';

/**
 * Check if setup is complete.
 *
 * OP_SETUP_COMPLETE is an app-written record stored in state/stack.env
 * (constitution §1). Only OP_SETUP_COMPLETE=true is authoritative.
 */
export function isSetupComplete(homeDir: string): boolean {
  return parseEnvFile(stackEnvFile(homeDir)).OP_SETUP_COMPLETE === "true";
}
