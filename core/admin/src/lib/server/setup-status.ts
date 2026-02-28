import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";

export function readSecretsKeys(configDir: string): Record<string, boolean> {
  const secretsPath = `${configDir}/secrets.env`;
  const result: Record<string, boolean> = {};

  if (existsSync(secretsPath)) {
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      result[key] = value.length > 0;
    }
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
  const stackEnvPath = `${stateDir}/artifacts/stack.env`;
  if (existsSync(stackEnvPath)) {
    const stackEnv = readFileSync(stackEnvPath, "utf-8");
    for (const line of stackEnv.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key !== "OPENPALM_SETUP_COMPLETE") continue;
      const value = trimmed.slice(eq + 1).trim().toLowerCase();
      return value === "true";
    }
  }

  const keys = readSecretsKeys(configDir);
  return keys.ADMIN_TOKEN === true;
}
