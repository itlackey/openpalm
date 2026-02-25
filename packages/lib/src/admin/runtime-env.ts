import { parseEnvContent, parseEnvLine } from "../shared/env-parser.ts";

export type AccessScope = "host" | "lan" | "public";

const RUNTIME_BIND_KEYS = {
  OPENPALM_INGRESS_BIND_ADDRESS: true,
  OPENPALM_OPENMEMORY_BIND_ADDRESS: true,
  OPENPALM_OPENMEMORY_DASHBOARD_BIND_ADDRESS: true,
  OPENPALM_ASSISTANT_BIND_ADDRESS: true,
  OPENPALM_ASSISTANT_SSH_BIND_ADDRESS: true,
} as const;

export function parseRuntimeEnvContent(content: string): Record<string, string> {
  return parseEnvContent(content);
}

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

export function setRuntimeBindScopeContent(content: string, scope: AccessScope): string {
  const bindAddress = scope === "host" ? "127.0.0.1" : "0.0.0.0";
  const entries: Record<string, string> = {
    OPENPALM_INGRESS_BIND_ADDRESS: bindAddress,
    OPENPALM_OPENMEMORY_BIND_ADDRESS: bindAddress,
    OPENPALM_OPENMEMORY_DASHBOARD_BIND_ADDRESS: bindAddress,
    OPENPALM_ASSISTANT_BIND_ADDRESS: bindAddress,
    OPENPALM_ASSISTANT_SSH_BIND_ADDRESS: bindAddress,
  };

  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const parsed = parseEnvLine(line);
    if (!parsed) return line;
    const [key] = parsed;
    if (key in RUNTIME_BIND_KEYS) {
      seen.add(key);
      return `${key}=${entries[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(entries)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  return next.join("\n").replace(/\n+$/, "") + "\n";
}

export function sanitizeEnvScalar(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, "").trim();
}
