import { writeFileSync, renameSync } from "node:fs";

/**
 * Write a file atomically: write to `${path}.tmp` then rename over the target.
 * The rename is atomic on the same filesystem, so readers never observe a
 * partially written file. `mode` (e.g. 0o600) is applied on creation.
 *
 * Shared by all control-plane writers (setup, akm-sources, …) so config and
 * secret files are written through one audited path — never hand-rolled.
 */
export function writeFileAtomic(path: string, content: string | Uint8Array, mode?: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, mode !== undefined ? { mode } : {});
  renameSync(tmp, path);
}
