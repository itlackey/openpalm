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
  // Password present means setup ran at some point. Covers pre-flag installs
  // and installs where writeSystemEnv wrote OP_SETUP_COMPLETE=false before
  // the password fallback was added (beta.10 and earlier wrote false whenever
  // the explicit flag was absent, which broke upgrades for users whose deploy
  // never made all containers healthy before the flag was first written).
  return (parsed.OP_UI_LOGIN_PASSWORD ?? "").length > 0;
}
