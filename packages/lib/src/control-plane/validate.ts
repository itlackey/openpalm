/**
 * Runtime configuration validation for the OpenPalm control plane.
 *
 * Validation is a presence check on the canonical env keys we expect in
 * the live system/stack files. The
 * historical schema files and external validation binary were retired in
 * #391; everything advisory is surfaced as a non-blocking warning. The
 * function never shells out and never reads schemas.
 */
import { existsSync, readFileSync } from "node:fs";
import { stateSecretsDir } from "./home.js";
import { readSecret } from "./secrets-files.js";
import { akmConfigPath, stackEnvPath } from "./paths.js";
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
      errors.push(`ERROR: required secret ${key} is missing or empty in ${stateSecretsDir(state.homeDir)}/${name}`);
    }
  }

  const akmWarning = checkAkmEngines(state);
  if (akmWarning) warnings.push(akmWarning);

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Advisory-only (never blocks `ok`): an existing akm config with no
 * `engines` entries leaves the assistant with no configured LLM — a state
 * that used to pass silently, including right after a 0.12.x -> 0.13.x
 * upgrade dropped `profiles.llm.*` with nothing translating it forward
 * (issue #645). Not promoted to an error: akm 0.9 itself treats zero
 * configured engines as a supported state and falls back to `opencode-sdk`
 * when the `opencode` binary is present, so failing `openpalm validate`
 * closed here would block a deploy that akm does not consider broken.
 * Skipped entirely when the config file does not exist yet — nothing to
 * warn about before setup has ever written one.
 */
function checkAkmEngines(state: ControlPlaneState): string | undefined {
  const configPath = akmConfigPath(state);
  if (!existsSync(configPath)) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // Unparseable akm config is a real problem, but not this check's problem
    // to report — akm itself fails closed and names the parse error.
    return undefined;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const engines = (config as Record<string, unknown>).engines;
  const engineCount =
    engines && typeof engines === "object" && !Array.isArray(engines) ? Object.keys(engines).length : 0;
  if (engineCount > 0) return undefined;
  return `WARNING: no akm engines configured in ${configPath} — the assistant has no LLM engine unless opencode itself is configured`;
}
