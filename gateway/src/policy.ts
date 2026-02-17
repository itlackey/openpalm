import type { Approval } from "./types.ts";

const SAFE_TOOLS = new Set(["memory_recall", "format_response", "local_query", "explain_recall"]);
const MEDIUM_TOOLS = new Set(["safe_fetch", "file_edit", "create_reminder"]);
const HIGH_TOOLS = new Set(["shell_exec", "file_delete", "external_api", "payment"]);
const SECRET_PATTERN = /(api[_-]?key|token|password|private[_-]?key|secret)/i;

export function classifyTool(toolName: string): "safe" | "medium" | "high" {
  if (SAFE_TOOLS.has(toolName)) return "safe";
  if (MEDIUM_TOOLS.has(toolName)) return "medium";
  if (HIGH_TOOLS.has(toolName)) return "high";
  return "high";
}

export function validateToolRequest(input: {
  toolName: string;
  args: Record<string, unknown>;
  allowlistDomains: string[];
  approval?: Approval;
}) {
  const risk = classifyTool(input.toolName);
  const serialized = JSON.stringify(input.args ?? {});

  if (SECRET_PATTERN.test(serialized)) {
    return { allowed: false, reason: "Possible secret in tool args.", risk };
  }

  if (input.toolName === "safe_fetch") {
    const url = String(input.args?.url ?? "");
    if (!url) return { allowed: false, reason: "Missing url for safe_fetch.", risk };
    const host = new URL(url).hostname;
    if (!input.allowlistDomains.includes(host)) {
      return { allowed: false, reason: `Domain ${host} not allowlisted.`, risk };
    }
  }

  if ((risk === "medium" || risk === "high") && !input.approval?.approved) {
    return { allowed: false, reason: `${risk} risk tool requires explicit approval.`, risk };
  }

  return { allowed: true, risk };
}

export function canRemember(text: string): boolean {
  return /^\s*remember\b/i.test(text);
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERN.test(text);
}
