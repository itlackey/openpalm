/**
 * One-shot migration for the 0.11.0 auth refactor.
 *
 * Existing installs have OP_UI_TOKEN and OP_ASSISTANT_TOKEN in
 * config/stack/stack.env. The 0.11.0 refactor (auth-and-proxy-refactor-plan.md)
 * replaces them with a single OP_UI_LOGIN_PASSWORD. If we don't migrate,
 * operators get locked out the moment they run the new UI build because the
 * login route compares the cookie against process.env.OP_UI_LOGIN_PASSWORD,
 * which is empty on existing installs.
 *
 * Migration logic (idempotent):
 *   - If OP_UI_LOGIN_PASSWORD is unset AND OP_UI_TOKEN is set, copy
 *     OP_UI_TOKEN's value into OP_UI_LOGIN_PASSWORD.
 *   - Remove OP_UI_TOKEN and OP_ASSISTANT_TOKEN from stack.env (they're
 *     no longer used).
 *   - Append a one-line summary to state/logs/migration-0.11.0.log.
 *   - If OP_UI_LOGIN_PASSWORD is already set, leave it alone — the operator
 *     already migrated or set up fresh.
 *
 * Called from ensureSecrets so it runs before any auth-required code path
 * gets a chance to see the half-migrated state.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseEnvContent, removeEnvKey, upsertEnvValue } from "./env.js";
import { migration0110LogPath } from "./paths.js";
import type { ControlPlaneState } from "./types.js";

export type MigrateAuth0110Result = {
  /** True if any change was written to stack.env. */
  migrated: boolean;
  /** Human-readable description of what changed (or why nothing did). */
  reason: string;
};

export function migrateAuth0110(state: ControlPlaneState): MigrateAuth0110Result {
  const stackEnvPath = `${state.stackDir}/stack.env`;
  if (!existsSync(stackEnvPath)) {
    return { migrated: false, reason: "no stack.env yet (fresh install)" };
  }

  const before = readFileSync(stackEnvPath, "utf-8");
  const parsed = parseEnvContent(before);
  const hasLoginPw = typeof parsed.OP_UI_LOGIN_PASSWORD === "string" && parsed.OP_UI_LOGIN_PASSWORD.length > 0;
  const hasUiToken = typeof parsed.OP_UI_TOKEN === "string" && parsed.OP_UI_TOKEN.length > 0;
  const hasAssistantToken = "OP_ASSISTANT_TOKEN" in parsed;
  const hasUiTokenLine = "OP_UI_TOKEN" in parsed;

  if (hasLoginPw && !hasUiTokenLine && !hasAssistantToken) {
    return { migrated: false, reason: "already migrated" };
  }

  let content = before;
  const changes: string[] = [];

  if (!hasLoginPw && hasUiToken) {
    content = upsertEnvValue(content, "OP_UI_LOGIN_PASSWORD", parsed.OP_UI_TOKEN);
    changes.push("promoted OP_UI_TOKEN → OP_UI_LOGIN_PASSWORD");
  }
  if (hasUiTokenLine) {
    content = removeEnvKey(content, "OP_UI_TOKEN");
    changes.push("removed OP_UI_TOKEN");
  }
  if (hasAssistantToken) {
    content = removeEnvKey(content, "OP_ASSISTANT_TOKEN");
    changes.push("removed OP_ASSISTANT_TOKEN");
  }

  if (changes.length === 0) {
    return { migrated: false, reason: "no changes needed" };
  }

  // Preserve the 0600 mode the existing file should already have.
  writeFileSync(stackEnvPath, content, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(stackEnvPath, 0o600); } catch { /* best-effort */ }

  // Best-effort audit line. The migration log is small and append-only;
  // if it fails (perm error, fs full), we don't roll back the migration.
  try {
    const logPath = migration0110LogPath(state);
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${new Date().toISOString()} migrate-auth-0110 ${changes.join("; ")}\n`,
      "utf-8",
    );
  } catch {
    /* best-effort */
  }

  return { migrated: true, reason: changes.join("; ") };
}
