import { readFileSync } from "node:fs";

export class SecretFileError extends Error {
  constructor(public readonly envKey: string, reason: string) {
    super(`${envKey}: ${reason}`);
    this.name = "SecretFileError";
  }
}

function stripTrailingNewline(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

export function readRequiredSecretFile(envKey: string, env: Record<string, string | undefined> = Bun.env): string {
  const path = env[envKey]?.trim();
  if (!path) {
    throw new SecretFileError(envKey, "secret file env var is not set");
  }

  let value: string;
  try {
    value = stripTrailingNewline(readFileSync(path, "utf8"));
  } catch {
    throw new SecretFileError(envKey, "secret file is unreadable");
  }

  if (!value) {
    throw new SecretFileError(envKey, "secret file is empty");
  }

  return value;
}

export function readOptionalSecretFile(envKey: string, env: Record<string, string | undefined> = Bun.env): string {
  if (!env[envKey]?.trim()) return "";
  return readRequiredSecretFile(envKey, env);
}
