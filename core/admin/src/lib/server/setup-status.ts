import { userInfo } from "node:os";
import { parseEnvFile } from "@openpalm/lib/shared/env";

export function readSecretsKeys(configDir: string): Record<string, boolean> {
  const parsed = parseEnvFile(`${configDir}/secrets.env`);
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

export function isSetupComplete(stateDir: string, configDir: string): boolean {
  const parsed = parseEnvFile(`${stateDir}/artifacts/stack.env`);
  if (parsed.OPENPALM_SETUP_COMPLETE?.toLowerCase() === "true") return true;

  const keys = readSecretsKeys(configDir);
  return keys.ADMIN_TOKEN === true;
}
