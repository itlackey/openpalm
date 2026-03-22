/**
 * Runtime configuration validation for the OpenPalm control plane.
 *
 * Proposed changes are validated against temp copies before writing
 * to live paths.
 */
import { existsSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ControlPlaneState } from "./types.js";

const execFileAsync = promisify(execFile);

/** Resolve the varlock binary path — honours VARLOCK_BIN for dev environments. */
const envVarlockBin = process.env.VARLOCK_BIN;
let VARLOCK_BIN = "varlock";
if (envVarlockBin) {
  if (envVarlockBin === "varlock" || envVarlockBin.startsWith("/")) {
    VARLOCK_BIN = envVarlockBin;
  }
}

function sanitizeVarlockMessage(msg: string): string {
  return msg
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .replace(/gsk_[A-Za-z0-9]{30,}/g, "[REDACTED]")
    .replace(/AIza[A-Za-z0-9_\-]{35}/g, "[REDACTED]")
    .replace(/[0-9a-f]{32,}/gi, "[REDACTED]")
    .replace(/value '([^']*)'/g, "value '[REDACTED]'");
}

async function runVarlockLoad(
  schemaFile: string,
  envFile: string,
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "varlock-"));
  try {
    copyFileSync(schemaFile, join(tmpDir, ".env.schema"));
    copyFileSync(envFile, join(tmpDir, ".env"));
    await execFileAsync(
      VARLOCK_BIN,
      ["load", "--path", `${tmpDir}/`],
      { timeout: 10000 },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Validate the current live configuration files in place.
 *
 * Checks:
 * 1. vault/user/user.env against vault/user/user.env.schema
 * 2. vault/stack/stack.env against vault/stack/stack.env.schema
 */
export async function validateProposedState(state: ControlPlaneState): Promise<{
  ok: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let anyFailed = false;

  function collectOutput(stderr: string): void {
    for (const line of stderr.split("\n")) {
      const trimmed = sanitizeVarlockMessage(line.trim());
      if (!trimmed) continue;
      if (trimmed.includes("ERROR")) errors.push(trimmed);
      else if (trimmed.includes("WARN")) warnings.push(trimmed);
    }
  }

  // Validate user.env
  const userEnvSchema = `${state.vaultDir}/user/user.env.schema`;
  const userEnv = `${state.vaultDir}/user/user.env`;
  if (existsSync(userEnvSchema) && existsSync(userEnv)) {
    try {
      await runVarlockLoad(userEnvSchema, userEnv);
    } catch (err: unknown) {
      anyFailed = true;
      if (err && typeof err === "object" && "stderr" in err) {
        collectOutput(String((err as { stderr: string }).stderr));
      }
    }
  }

  // Validate stack.env
  const systemEnvSchema = `${state.vaultDir}/stack/stack.env.schema`;
  const systemEnv = `${state.vaultDir}/stack/stack.env`;
  if (existsSync(systemEnvSchema) && existsSync(systemEnv)) {
    try {
      await runVarlockLoad(systemEnvSchema, systemEnv);
    } catch (err: unknown) {
      anyFailed = true;
      if (err && typeof err === "object" && "stderr" in err) {
        collectOutput(String((err as { stderr: string }).stderr));
      }
    }
  }

  return { ok: !anyFailed && errors.length === 0, errors, warnings };
}
