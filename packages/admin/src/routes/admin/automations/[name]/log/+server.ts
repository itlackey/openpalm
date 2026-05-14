/**
 * GET /admin/automations/:name/log — Recent scheduler log lines for an
 * automation.
 *
 * The scheduler co-process writes a JSON-lines log to
 * `${OP_HOME}/logs/scheduler.log`. This endpoint reads the tail of that
 * file and returns lines that mention the requested automation's
 * fileName. There is no in-memory execution log anymore; the file IS the
 * log.
 *
 * Optional `limit` query parameter caps the number of returned entries
 * (default 50, max 500).
 */
import type { RequestHandler } from "./$types";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAuth,
  getRequestId,
  getActor,
  getCallerType,
} from "$lib/server/helpers.js";
import { appendAudit } from "@openpalm/lib";

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+\.yml$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
// Cap the bytes we read from the tail of the log to avoid pulling a huge
// file into memory on every request. 256 KiB comfortably holds several
// hundred log lines.
const MAX_TAIL_BYTES = 256 * 1024;

type LogEntry = {
  at: string;
  level?: string;
  msg?: string;
  raw: string;
};

function parseLogLine(line: string): LogEntry | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    return {
      at: typeof obj.ts === "string" ? obj.ts : new Date().toISOString(),
      level: typeof obj.level === "string" ? obj.level : undefined,
      msg: typeof obj.msg === "string" ? obj.msg : undefined,
      raw: line,
    };
  } catch {
    return { at: "", raw: line };
  }
}

function readTail(path: string, maxBytes: number): string {
  // Simple read-whole-file-then-slice; acceptable because we cap the size
  // we keep and the log rotates externally (it lives under logs/ which the
  // operator manages). This avoids platform-specific seek/stat dance.
  const buf = readFileSync(path);
  if (buf.byteLength <= maxBytes) return buf.toString("utf-8");
  return buf.subarray(buf.byteLength - maxBytes).toString("utf-8");
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const rawName = event.params.name ?? "";
  const fileName = rawName.endsWith(".yml") ? rawName : `${rawName}.yml`;

  if (!SAFE_NAME_RE.test(fileName) || fileName.includes("..") || fileName.includes("/")) {
    return errorResponse(400, "invalid_input", "name must match /^[a-zA-Z0-9._-]+\\.yml$/", {}, requestId);
  }

  const limitParam = event.url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return errorResponse(400, "invalid_input", "limit must be a positive integer", {}, requestId);
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const logPath = join(state.logsDir, "scheduler.log");
  let entries: LogEntry[] = [];

  if (existsSync(logPath)) {
    try {
      const tail = readTail(logPath, MAX_TAIL_BYTES);
      const lines = tail.split("\n");
      // Drop the first line if we truncated mid-line.
      if (tail.length === MAX_TAIL_BYTES) lines.shift();

      for (const line of lines) {
        if (!line.includes(fileName)) continue;
        const parsed = parseLogLine(line);
        if (parsed) entries.push(parsed);
      }

      if (entries.length > limit) entries = entries.slice(-limit);
    } catch (err) {
      appendAudit(state, actor, "automations.log", { fileName, error: String(err) }, false, requestId, callerType);
      return errorResponse(500, "internal_error", `Failed to read scheduler log: ${String(err)}`, {}, requestId);
    }
  }

  appendAudit(state, actor, "automations.log", { fileName, count: entries.length }, true, requestId, callerType);
  // Newest first to match the old `triggerAutomation` log layout.
  return jsonResponse(200, { fileName, entries: entries.reverse() }, requestId);
};
