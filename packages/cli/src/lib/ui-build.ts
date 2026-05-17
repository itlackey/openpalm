/**
 * Admin build tarball extraction.
 *
 * Extracts the embedded SvelteKit adapter-node build to
 * `{cacheDir}/admin/{version}/` so the host admin server can load it.
 * Idempotent: if the version directory already exists, extraction is skipped.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EMBEDDED_ADMIN_TAR, ADMIN_BUILD_VERSION } from "./embedded-assets.ts";

/**
 * Ensure the admin build is extracted to the cache directory.
 * Returns the path to the extracted build root (contains index.js, handler.js, client/, etc.)
 */
export function ensureAdminBuild(cacheDir: string): string {
  const versionDir = join(cacheDir, "admin", ADMIN_BUILD_VERSION);

  if (existsSync(join(versionDir, "index.js"))) {
    return versionDir;
  }

  mkdirSync(versionDir, { recursive: true });

  // Write tarball to a temp file, then extract with system tar
  const tarPath = join(tmpdir(), `openpalm-admin-build-${ADMIN_BUILD_VERSION}.tar.gz`);
  writeFileSync(tarPath, EMBEDDED_ADMIN_TAR);

  const result = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", versionDir], {
    stdout: "ignore",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`Failed to extract admin build: ${stderr}`);
  }

  return versionDir;
}
