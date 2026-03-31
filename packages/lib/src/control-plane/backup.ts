import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

function timestampDirName(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Create a durable backup snapshot of the current OP_HOME contents.
 *
 * The backup is written under OP_HOME/backups/<timestamp>/ and excludes the
 * backups directory itself to avoid recursive copies.
 */
export function backupOpenPalmHome(homeDir: string): string | null {
  if (!existsSync(homeDir)) return null;

  const backupDir = join(homeDir, "backups", timestampDirName());
  mkdirSync(backupDir, { recursive: true });

  let copiedAny = false;
  for (const entry of readdirSync(homeDir, { withFileTypes: true })) {
    if (entry.name === "backups") continue;

    const sourcePath = join(homeDir, entry.name);
    const targetPath = join(backupDir, entry.name);
    cpSync(sourcePath, targetPath, { recursive: true });
    copiedAny = true;
  }

  return copiedAny ? backupDir : null;
}
