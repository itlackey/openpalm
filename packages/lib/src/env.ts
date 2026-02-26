import { parseEnvContent } from "./shared/env-parser.ts";

export async function readEnvFile(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return {};
  }

  const content = await file.text();
  return parseEnvContent(content, { stripQuotedValues: true });
}

export async function upsertEnvVar(path: string, key: string, value: string): Promise<void> {
  return upsertEnvVars(path, [[key, value]]);
}

/**
 * Upserts multiple key-value pairs into an env file in a single read-write cycle.
 * Prefer this over calling `upsertEnvVar` repeatedly when writing several keys
 * to the same file, as it avoids N redundant read-write operations.
 */
export async function upsertEnvVars(filePath: string, entries: [key: string, value: string][]): Promise<void> {
  if (entries.length === 0) return;

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    await Bun.write(filePath, entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    return;
  }

  const entryMap = new Map(entries);
  const updated = new Set<string>();
  const lines = (await file.text()).split("\n");
  const newLines: string[] = [];

  for (const line of lines) {
    const eqIndex = line.indexOf("=");
    const key = eqIndex > 0 ? line.slice(0, eqIndex).trim() : "";
    if (key && entryMap.has(key)) {
      newLines.push(`${key}=${entryMap.get(key)}`);
      updated.add(key);
    } else {
      newLines.push(line);
    }
  }

  const toAppend = entries.filter(([k]) => !updated.has(k));
  if (toAppend.length > 0) {
    while (newLines.length > 0 && newLines[newLines.length - 1].trim() === "") newLines.pop();
    for (const [k, v] of toAppend) newLines.push(`${k}=${v}`);
    newLines.push("");
  }

  await Bun.write(filePath, newLines.join("\n"));
}

