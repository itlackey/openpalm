/**
 * Runtime configuration validation for the OpenPalm control plane.
 *
 * Validation is a presence check on the canonical env keys we expect in
 * the live system/stack files. The
 * historical schema files and external validation binary were retired in
 * #391; everything advisory is surfaced as a non-blocking warning. The
 * function never shells out and never reads schemas.
 */
import { existsSync } from "node:fs";
import { privateSecretsDir } from "./home.js";
import { readSecret } from "./secrets-files.js";
import { stackEnvPath } from "./paths.js";
import type { ControlPlaneState } from "./types.js";

// Stack-scoped env keys that must always exist and carry a non-empty value
// for the platform to boot. Keep this list small — anything optional
// belongs in the warning bucket instead.
const REQUIRED_SECRET_KEYS = ["OP_UI_LOGIN_PASSWORD"] as const;

/**
 * Validate the live configuration files.
 *
 * Checks:
 * 1. state/stack.env exists.
 * 2. Every required file secret carries a non-empty value.
 *
 * Errors fail the result. Warnings do not. The function never reads
 * schema files and never spawns subprocesses.
 */
export async function validateProposedState(state: ControlPlaneState): Promise<{
  ok: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const stackEnvFile = stackEnvPath(state);

  if (!existsSync(stackEnvFile)) {
    errors.push(`ERROR: stack env file missing at ${stackEnvFile}`);
    return { ok: false, errors, warnings };
  }

  for (const key of REQUIRED_SECRET_KEYS) {
    const name = key.toLowerCase();
    const value = readSecret(state.homeDir, name);
    if (!value || value.trim().length === 0) {
      errors.push(`ERROR: required secret ${key} is missing or empty in ${privateSecretsDir(state.homeDir)}/${name}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
