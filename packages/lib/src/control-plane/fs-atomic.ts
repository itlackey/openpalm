import { writeFileSync, renameSync, copyFileSync, rmSync, chmodSync } from "node:fs";

/** Write atomically: tmp file + rename. `mode` is applied on creation. */
export function writeFileAtomic(path: string, content: string | Uint8Array, mode?: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, mode !== undefined ? { mode } : {});
  renameSync(tmp, path);
}

/**
 * Write while keeping the file's inode. Required for single-file bind-mount
 * sources (auth.json): a rename gives the host a new inode while running
 * containers keep the old one, so they silently stop seeing host writes.
 * Not atomic — a reader can observe a short file mid-write.
 */
export function writeFileInPlace(path: string, content: string | Uint8Array, mode?: number): void {
  const tmp = `${path}.${process.pid}.inplace.tmp`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, content, mode !== undefined ? { mode } : {});
    copyFileSync(tmp, path);
    if (mode !== undefined) chmodSync(path, mode);
  } finally {
    rmSync(tmp, { force: true });
  }
}
