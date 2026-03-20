/**
 * Home layout path resolution — re-exported from @openpalm/lib.
 */
export {
  resolveOpenPalmHome,
  resolveConfigDir,
  resolveVaultDir,
  resolveDataDir,
  resolveLogsDir,
  resolveCacheHome,
  resolveRegistryCacheDir,
  ensureHomeDirs,
  // Deprecated aliases
  resolveConfigDir as resolveConfigHome,
  resolveLogsDir as resolveStateHome,
  resolveDataDir as resolveDataHome,
  ensureHomeDirs as ensureXdgDirs,
} from "@openpalm/lib";
