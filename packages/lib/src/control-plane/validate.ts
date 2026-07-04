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
import { readStackRuntimeEnv } from "./secrets.js";
import { STATIC_CORE_MAPPINGS } from "./secret-mappings.js";
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
 * 1. knowledge/env/stack.env exists and carries every required key with a
 *    non-empty value.
 * 2. Every secret env key in STATIC_CORE_MAPPINGS is present (key only
 *    — blank values are warned about, never erred on, because operators
 *    may opt out of providers they don't use).
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

  const runtimeEnv = readStackRuntimeEnv(state.homeDir);

  for (const key of REQUIRED_SECRET_KEYS) {
    const value = runtimeEnv[key];
    if (!value || value.trim().length === 0) {
      errors.push(`ERROR: required secret ${key} is missing or empty in knowledge/secrets/${key.toLowerCase()}`);
    }
  }

  // Every canonical secret should at least appear as a key somewhere in
  // the env files so the operator sees the slot. Missing slots warn (not
  // error) since not every provider is in use on every install.
  for (const mapping of STATIC_CORE_MAPPINGS) {
    const inRuntime = Object.hasOwn(runtimeEnv, mapping.envKey);
    if (!inRuntime) {
      warnings.push(
        `WARN: ${mapping.envKey} (akm ${mapping.secretKey}) is not declared in knowledge/secrets/${mapping.envKey.toLowerCase()}`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
