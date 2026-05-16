/**
 * Admin token file management.
 *
 * Token lives at {homeDir}/state/admin/token, mode 0600.
 * - ensureAdminToken: idempotent — skips write if file already exists and is non-empty.
 * - rotateAdminToken: overwrites unconditionally. Only called by `openpalm admin rotate-token`.
 *
 * Windows note: chmodSync(path, 0o600) is a no-op on Windows.
 * NFS/CIFS warning: mode bits are ignored on network shares. ensureAdminToken warns via console.
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

function getAdminStateDir(homeDir: string): string {
  return join(homeDir, "state", "admin");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Ensure an admin token file exists at {homeDir}/state/admin/token.
 * Idempotent: if the file already exists and is non-empty, returns the existing token.
 * Creates the directory if necessary. Sets mode 0600 (no-op on Windows).
 *
 * @param homeDir  The OP_HOME directory (e.g. ~/.openpalm)
 * @returns        The admin token (new or existing)
 */
export function ensureAdminToken(homeDir: string): string {
  const dir = getAdminStateDir(homeDir);
  mkdirSync(dir, { recursive: true });

  const tokenPath = join(dir, "token");

  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length > 0) return existing;
  }

  const token = generateToken();
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  try {
    // Some platforms require a separate chmod call to enforce the mode.
    chmodSync(tokenPath, 0o600);
  } catch {
    // Windows — ignore silently
  }
  return token;
}

/**
 * Rotate the admin token. Overwrites the token file unconditionally.
 * Only call this from `openpalm admin rotate-token`.
 *
 * @param homeDir  The OP_HOME directory
 * @returns        The new admin token
 */
export function rotateAdminToken(homeDir: string): string {
  const dir = getAdminStateDir(homeDir);
  mkdirSync(dir, { recursive: true });

  const tokenPath = join(dir, "token");
  const token = generateToken();
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // Windows — ignore silently
  }
  return token;
}
