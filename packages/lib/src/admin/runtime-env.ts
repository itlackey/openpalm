import { parseEnvLine } from "../shared/env-parser.ts";

export function updateRuntimeEnvContent(content: string, entries: Record<string, string | undefined>): string {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const managedKeys = new Set(Object.keys(entries));
  const next: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      next.push(line);
      continue;
    }

    const [key] = parsed;
    if (!managedKeys.has(key)) {
      next.push(line);
      continue;
    }

    seen.add(key);
    const value = entries[key];
    if (typeof value === "string" && value.length > 0) {
      next.push(`${key}=${value}`);
    }
  }

  for (const [key, value] of Object.entries(entries)) {
    if (seen.has(key)) continue;
    if (typeof value === "string" && value.length > 0) next.push(`${key}=${value}`);
  }

  return next.join("\n").replace(/\n+$/, "") + "\n";
}

export function sanitizeEnvScalar(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, "").trim();
}
