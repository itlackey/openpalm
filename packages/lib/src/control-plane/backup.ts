import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

function timestampDirName(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Create a durable backup snapshot of the current OP_HOME contents.
 *
 * The backup is written under OP_HOME/data/backups/<timestamp>/ and excludes
 * existing backups to avoid recursive copies.
 */
export function backupOpenPalmHome(homeDir: string): string | null {
  if (!existsSync(homeDir)) return null;

  const backupDir = join(homeDir, "data", "backups", timestampDirName());
  mkdirSync(backupDir, { recursive: true });

  let copiedAny = false;
  for (const entry of readdirSync(homeDir, { withFileTypes: true })) {
    const sourcePath = join(homeDir, entry.name);
    if (entry.name === "data") {
      const dataTarget = join(backupDir, entry.name);
      mkdirSync(dataTarget, { recursive: true });
      for (const dataEntry of readdirSync(sourcePath, { withFileTypes: true })) {
        if (dataEntry.name === "backups") continue;
        cpSync(join(sourcePath, dataEntry.name), join(dataTarget, dataEntry.name), { recursive: true });
        copiedAny = true;
      }
      continue;
    }

    const targetPath = join(backupDir, entry.name);
    cpSync(sourcePath, targetPath, { recursive: true });
    copiedAny = true;
  }

  return copiedAny ? backupDir : null;
}
