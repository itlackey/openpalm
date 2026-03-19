/**
 * XDG path resolution — DEPRECATED compatibility shim.
 *
 * v0.10.0 uses the ~/.openpalm/ home layout (see home.ts).
 * These functions now delegate to the new resolvers. Callers should
 * migrate to the home.ts API directly.
 *
 * @deprecated Use home.ts resolvers (resolveConfigDir, resolveDataDir, etc.)
 */
import {
  resolveHome,
  resolveConfigDir,
  resolveDataDir,
  resolveLogsDir,
  ensureHomeDirs,
} from "./home.js";

export { resolveHome };

/** @deprecated Use resolveConfigDir() from home.ts */
export function resolveConfigHome(): string {
  return resolveConfigDir();
}

/** @deprecated Use resolveLogsDir() from home.ts */
export function resolveStateHome(): string {
  return resolveLogsDir();
}

/** @deprecated Use resolveDataDir() from home.ts */
export function resolveDataHome(): string {
  return resolveDataDir();
}

/** @deprecated Use ensureHomeDirs() from home.ts */
export function ensureXdgDirs(): void {
  ensureHomeDirs();
}
