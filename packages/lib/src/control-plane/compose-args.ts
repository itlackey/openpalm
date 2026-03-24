/**
 * Canonical compose argument builder.
 *
 * Consolidates compose file/env-file resolution and CLI argument
 * construction into a single shared module. Both CLI and admin
 * routes use these functions instead of assembling args inline.
 */
import { existsSync } from "node:fs";
import type { ControlPlaneState } from "./types.js";
import { buildComposeFileList } from "./lifecycle.js";
import { buildEnvFiles } from "./config-persistence.js";
import { resolveComposeProjectName } from "./docker.js";

// ── Constants ────────────────────────────────────────────────────────────

export const COMPOSE_PROJECT_NAME = "openpalm";

// ── Types ────────────────────────────────────────────────────────────────

export type ComposeOptions = {
  files: string[];
  envFiles: string[];
};

// ── Builders ─────────────────────────────────────────────────────────────

/**
 * Build the compose file and env file lists for a given state.
 * Returns the resolved files and env files for use with docker.ts functions.
 */
export function buildComposeOptions(state: ControlPlaneState): ComposeOptions {
  return {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
  };
}

/**
 * Build the full docker compose CLI argument array for a given state.
 *
 * Returns: ['--project-name', 'openpalm', '-f', file1, '-f', file2, '--env-file', env1, ...]
 *
 * Only includes env files that exist on disk.
 */
export function buildComposeCliArgs(state: ControlPlaneState): string[] {
  const { files, envFiles } = buildComposeOptions(state);

  return [
    "--project-name",
    resolveComposeProjectName(),
    ...files.flatMap((f) => ["-f", f]),
    ...envFiles.filter((f) => existsSync(f)).flatMap((f) => ["--env-file", f]),
  ];
}
