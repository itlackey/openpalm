/**
 * Shell action executor — uses execFile with argument arrays.
 *
 * Security: NO shell interpolation. Uses a minimal environment from
 * an allowlist of safe variables to prevent secret leakage.
 */
import { execFile } from "node:child_process";
import type { AutomationAction } from "@openpalm/lib";

/** Safe env vars allowlisted for shell automation actions. */
const SHELL_SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_ENV",
  "OPENPALM_HOME",
  "OPENPALM_CONFIG_HOME",
  "OPENPALM_STATE_HOME",
  "OPENPALM_DATA_HOME",
];

export function executeShellAction(action: AutomationAction): Promise<void> {
  const cmd = action.command;
  if (!cmd || cmd.length === 0) {
    return Promise.reject(new Error("shell action requires a non-empty 'command' array"));
  }

  // Build a minimal env from the allowlist — never leak secrets to shell commands
  const safeEnv: Record<string, string> = {};
  for (const key of SHELL_SAFE_ENV_KEYS) {
    if (process.env[key]) safeEnv[key] = process.env[key]!;
  }

  return new Promise((resolve, reject) => {
    execFile(
      cmd[0],
      cmd.slice(1),
      { env: safeEnv, timeout: action.timeout ?? 30_000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`shell command failed: ${stderr || error.message}`));
        } else {
          resolve();
        }
      },
    );
  });
}
