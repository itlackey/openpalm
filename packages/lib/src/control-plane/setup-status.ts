import { parseEnvFile } from './env.js';

/**
 * Check if setup is complete by reading config/stack/stack.env.
 *
 * Phase 4 of the auth/proxy refactor replaced the legacy `OP_UI_TOKEN`
 * sentinel with `OP_UI_LOGIN_PASSWORD`. The presence of a non-empty value
 * implies the operator (or the install wizard) has seeded the login
 * secret; `OP_SETUP_COMPLETE=true` is still authoritative when present.
 */
export function isSetupComplete(stackDir: string): boolean {
  const parsed = parseEnvFile(`${stackDir}/stack.env`);
  if ("OP_SETUP_COMPLETE" in parsed) {
    return parsed.OP_SETUP_COMPLETE.toLowerCase() === "true";
  }

  return (parsed.OP_UI_LOGIN_PASSWORD ?? "").length > 0;
}
