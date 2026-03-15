/**
 * GET /admin/audit — Read audit log entries.
 *
 * Query params:
 *   limit  — max entries to return (default: all, capped at 1000)
 *   source — "admin" (default), "guardian", or "all"
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { jsonResponse, errorResponse, requireAdmin, getRequestId } from "$lib/server/helpers.js";

type GuardianAuditEntry = {
  ts: string;
  requestId?: string;
  sessionId?: string;
  action?: string;
  status?: string;
  channel?: string;
  userId?: string;
  [key: string]: unknown;
};

/** Read guardian audit JSONL file, returning parsed entries. */
async function readGuardianAudit(stateDir: string): Promise<GuardianAuditEntry[]> {
  const filePath = join(stateDir, "audit", "guardian-audit.log");
  try {
    const content = await readFile(filePath, "utf-8");
    const entries: GuardianAuditEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as GuardianAuditEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch {
    // File doesn't exist yet or is unreadable — return empty
    return [];
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const url = new URL(event.request.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const source = url.searchParams.get("source") ?? "admin";

  if (source !== "admin" && source !== "guardian" && source !== "all") {
    return errorResponse(400, "invalid_parameter", "source must be admin, guardian, or all", {}, requestId);
  }

  if (source === "admin") {
    const limit = Math.min(rawLimit > 0 ? rawLimit : state.audit.length, 1000);
    return jsonResponse(200, { audit: state.audit.slice(-limit) }, requestId);
  }

  if (source === "guardian") {
    const guardianEntries = await readGuardianAudit(state.stateDir);
    const limit = Math.min(rawLimit > 0 ? rawLimit : guardianEntries.length, 1000);
    return jsonResponse(200, { audit: guardianEntries.slice(-limit) }, requestId);
  }

  // source === "all": merge admin and guardian entries, sort by timestamp descending
  const guardianEntries = await readGuardianAudit(state.stateDir);

  // Normalize both sources into a common shape with a timestamp key
  const adminNormalized = state.audit.map((e) => ({
    ...e,
    _source: "admin" as const,
    _sortTs: e.at
  }));
  const guardianNormalized = guardianEntries.map((e) => ({
    ...e,
    _source: "guardian" as const,
    _sortTs: e.ts
  }));

  const merged = [...adminNormalized, ...guardianNormalized];
  merged.sort((a, b) => {
    // Sort descending by timestamp (newest first)
    if (a._sortTs > b._sortTs) return -1;
    if (a._sortTs < b._sortTs) return 1;
    return 0;
  });

  const limit = Math.min(rawLimit > 0 ? rawLimit : merged.length, 1000);
  const result = merged.slice(0, limit).map(({ _sortTs, ...entry }) => entry);

  return jsonResponse(200, { audit: result }, requestId);
};
