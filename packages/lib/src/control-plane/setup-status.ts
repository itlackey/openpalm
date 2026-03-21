import { userInfo } from "node:os";
import { parseEnvFile } from './env.js';

export function readSecretsKeys(vaultDir: string): Record<string, boolean> {
  // System scope wins on overlap because vault/stack/stack.env is the
  // authoritative source for system-managed credentials and flags.
  const parsed = {
    ...parseEnvFile(`${vaultDir}/user/user.env`),
    ...parseEnvFile(`${vaultDir}/stack/stack.env`),
  };
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    result[key] = value.length > 0;
  }
  return result;
}

export function detectUserId(): string {
  const envUser = process.env.USER ?? process.env.LOGNAME ?? "";
  if (envUser) return envUser;
  try {
    return userInfo().username || "default_user";
  } catch {
    return "default_user";
  }
}

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
