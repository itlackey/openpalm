import { userInfo } from "node:os";
import { parseEnvFile } from './env.js';

export function readSecretsKeys(vaultDir: string): Record<string, boolean> {
  const parsed = parseEnvFile(`${vaultDir}/user.env`);
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
 * Check if setup is complete by reading vault/system.env.
 */
export function isSetupComplete(vaultDir: string): boolean {
  const parsed = parseEnvFile(`${vaultDir}/system.env`);
  if ("OPENPALM_SETUP_COMPLETE" in parsed) {
    return parsed.OPENPALM_SETUP_COMPLETE.toLowerCase() === "true";
  }

  // Fallback: check if admin token exists in user.env
  const userParsed = parseEnvFile(`${vaultDir}/user.env`);
  // Also check system.env for admin token
  return (parsed.OPENPALM_ADMIN_TOKEN ?? "").length > 0 ||
    (userParsed.OPENPALM_ADMIN_TOKEN ?? "").length > 0;
}
