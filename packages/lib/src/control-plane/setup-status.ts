import { existsSync } from 'node:fs';
import { parseEnvFile } from './env.js';
import { legacyStackEnvFile, stateEnvFile } from './home.js';

/**
 * Check if setup is complete.
 *
 * OP_SETUP_COMPLETE is an app-written record stored in state/stack.state.env
 * (constitution §1). Merge state OVER the legacy knowledge/env/stack.env so that
 * installs which recorded completion in the legacy file still read as complete.
 * Only OP_SETUP_COMPLETE=true is authoritative.
 */
export function isSetupComplete(homeDir: string): boolean {
  const legacy = parseEnvFile(legacyStackEnvFile(homeDir));
  const state = existsSync(stateEnvFile(homeDir)) ? parseEnvFile(stateEnvFile(homeDir)) : {};
  return { ...legacy, ...state }.OP_SETUP_COMPLETE === "true";
}
