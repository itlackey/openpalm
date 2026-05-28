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
  if (parsed.OP_SETUP_COMPLETE === "true") return true;
  // Explicit false wins — covers fresh installs where ensureSecrets seeds a
  // random OP_UI_LOGIN_PASSWORD before setup runs (without this check the
  // non-empty password would bypass the wizard on first launch).
  if (parsed.OP_SETUP_COMPLETE === "false") return false;
  // No explicit flag: password present means setup ran at some point.
  // Covers pre-flag installs (beta.10 and earlier) where the flag was never
  // written but setup did complete.
  return (parsed.OP_UI_LOGIN_PASSWORD ?? "").length > 0;
}
