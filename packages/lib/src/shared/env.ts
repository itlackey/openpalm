/**
 * Shared .env file utilities backed by dotenv.parse().
 *
 * READ helpers delegate to dotenv for robust handling of comments,
 * quoted values, inline comments, and blank lines.
 *
 * WRITE helpers preserve the original file structure (comments,
 * ordering, blank lines) while merging key-value updates.
 */
import { parse as dotenvParse } from "dotenv";
import { readFileSync, existsSync } from "node:fs";

// ── READ helpers ────────────────────────────────────────────────────

/** Parse raw .env content string into a key-value record. */
export function parseEnvContent(content: string): Record<string, string> {
  return dotenvParse(content);
}

/** Read and parse a .env file. Returns empty record if file doesn't exist. */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    return dotenvParse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

// ── WRITE helpers ───────────────────────────────────────────────────

/**
 * Merge key-value updates into .env content while preserving structure
 * (comments, blank lines, ordering).
 *
 * 1. For each line containing a key in `updates`, replace the line.
 *    If `uncomment` is true, commented-out keys (`# KEY=`) are also matched.
 * 2. Append any remaining keys not found in the file.
 *
 * Returns the updated content string (does NOT write to disk).
 */
export function mergeEnvContent(
  content: string,
  updates: Record<string, string>,
  options: { uncomment?: boolean; sectionHeader?: string } = {}
): string {
  const lines = content.split("\n");
  const remaining = new Map(Object.entries(updates));

  for (let i = 0; i < lines.length; i++) {
    let testLine = lines[i].trim();
    if (options.uncomment) {
      testLine = testLine.replace(/^#\s*/, "").trim();
    }
    const eq = testLine.indexOf("=");
    if (eq <= 0) continue;
    const key = testLine.slice(0, eq).trim();
    if (remaining.has(key)) {
      lines[i] = `${key}=${remaining.get(key)}`;
      remaining.delete(key);
    }
  }

  if (remaining.size > 0) {
    lines.push("");
    if (options.sectionHeader) {
      lines.push(options.sectionHeader);
    }
    for (const [key, value] of remaining) {
      lines.push(`${key}=${value}`);
    }
  }

  return lines.join("\n");
}
