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
import { listEnabledAddonIds } from "./addons.js";
import { privateSecretsDir } from "./home.js";
import { readSecret } from "./secrets-files.js";
import { stackEnvPath } from "./paths.js";
import { readStackEnv } from "./secrets.js";
import type { ControlPlaneState } from "./types.js";

// Stack-scoped env keys that must always exist and carry a non-empty value
// for the platform to boot. Keep this list small — anything optional
// belongs in the warning bucket instead.
const REQUIRED_SECRET_KEYS = ["OP_UI_LOGIN_PASSWORD"] as const;

/**
 * The allow-scopes each portal adapter reads, and the sentence to say when
 * none of them is set.
 *
 * Portals are default-deny (portal-sdk `checkPermissions`, G3): with EVERY
 * allow-scope empty, the engine answers `no_allowlist_configured` and rejects
 * every caller. The adapter logs that once at startup, but nothing else
 * reports it — the container is running, its port is open, its healthcheck is
 * a bare TCP connect, and `openpalm status` shows it up. So the one state in
 * which a portal cannot do its job at all is the state that looks healthiest.
 *
 * Naming it here puts it in front of the operator at the three moments it can
 * change: `openpalm install`, `openpalm update` (both through
 * `auditApplyState`), and `openpalm validate` / the Host console's config
 * check. It stays a WARNING, not an error: an operator may be mid-setup, and
 * a portal that denies everyone is a closed door, not an unsafe one — and
 * `up --wait` failing the whole deploy over it would be far worse than the
 * problem.
 */
const PORTAL_ALLOWLIST_SCOPES: Record<string, { keys: string[]; allowAllKey: string }> = {
  discord: {
    keys: ["DISCORD_ALLOWED_USERS", "DISCORD_ALLOWED_GUILDS", "DISCORD_ALLOWED_ROLES"],
    allowAllKey: "DISCORD_ALLOWED_USERS",
  },
  slack: {
    keys: ["SLACK_ALLOWED_USERS", "SLACK_ALLOWED_CHANNELS"],
    allowAllKey: "SLACK_ALLOWED_USERS",
  },
};

/**
 * Mirrors portal-sdk's `parseIdList`: comma-separated, trimmed, blanks
 * dropped. A value of `" , "` is not an allowlist, and must not read as one.
 */
function hasAnyId(raw: string | undefined): boolean {
  return Boolean(
    raw
      ?.split(",")
      .map((entry) => entry.trim())
      .some(Boolean),
  );
}

/** One warning per enabled portal whose allowlist would deny every caller. */
export function checkPortalAllowlists(homeDir: string): string[] {
  let env: Record<string, string> | undefined;
  const warnings: string[] = [];
  for (const addon of listEnabledAddonIds(homeDir)) {
    const scopes = PORTAL_ALLOWLIST_SCOPES[addon];
    if (!scopes) continue;
    env ??= readStackEnv(homeDir);
    if (scopes.keys.some((key) => hasAnyId(env?.[key]))) continue;
    warnings.push(
      `WARNING: the ${addon} portal is enabled but no allowlist is configured ` +
        `(${scopes.keys.join(", ")} are all empty), so it will DENY every user. ` +
        `Set one of them, or ${scopes.allowAllKey}="*" to explicitly allow everyone.`,
    );
  }
  return warnings;
}

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

  warnings.push(...checkPortalAllowlists(state.homeDir));

  return { ok: errors.length === 0, errors, warnings };
}
