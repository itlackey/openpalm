/**
 * Lightweight structured JSON logger with optional file persistence.
 *
 * Usage:
 *   import { createLogger } from "@openpalm/lib/shared/logger.ts";
 *   const log = createLogger("admin");
 *   log.info("server started", { port: 8100 });
 *   // => {"ts":"2026-02-21T...","level":"info","service":"admin","msg":"server started","extra":{"port":8100}}
 *
 * Log level filtering:
 *   Set LOG_LEVEL=debug|info|warn|error (default: "info").
 *   DEBUG=1 is a shorthand for LOG_LEVEL=debug.
 *   Messages below the configured level are silently dropped.
 *
 * File logging:
 *   Set LOG_DIR to a writable directory path. When set, all log entries are
 *   also appended as JSONL to ${LOG_DIR}/service.log. Files are rotated at
 *   50 MB (renamed to .log.1). Both console and file output are produced.
 */

import { mkdirSync, statSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_LOG_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function getMinLevel(): LogLevel {
  if (Bun.env.DEBUG === "1") return "debug";
  const raw = Bun.env.LOG_LEVEL;
  if (raw && raw in LEVEL_PRIORITY) return raw as LogLevel;
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinLevel()];
}

function getLogFilePath(): string | null {
  const dir = Bun.env.LOG_DIR;
  if (!dir) return null;
  return join(dir, "service.log");
}

let logDirInitialized = false;

function writeToFile(filePath: string, line: string): void {
  if (!logDirInitialized) {
    try {
      mkdirSync(filePath.substring(0, filePath.lastIndexOf("/")), { recursive: true });
    } catch {
      // directory may already exist
    }
    logDirInitialized = true;
  }
  try {
    const stats = statSync(filePath);
    if (stats.size >= MAX_LOG_FILE_SIZE) {
      renameSync(filePath, `${filePath}.1`);
    }
  } catch {
    // file may not exist yet — that is fine
  }
  try {
    appendFileSync(filePath, line + "\n", "utf8");
  } catch {
    // silently ignore file write errors to avoid log loops
  }
}

function emit(level: LogLevel, service: string, msg: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service,
    msg,
  };
  if (extra !== undefined && Object.keys(extra).length > 0) {
    entry.extra = extra;
  }
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  const filePath = getLogFilePath();
  if (filePath) writeToFile(filePath, line);
}

export function createLogger(service: string): Logger {
  return {
    debug(msg: string, extra?: Record<string, unknown>): void {
      emit("debug", service, msg, extra);
    },
    info(msg: string, extra?: Record<string, unknown>): void {
      emit("info", service, msg, extra);
    },
    warn(msg: string, extra?: Record<string, unknown>): void {
      emit("warn", service, msg, extra);
    },
    error(msg: string, extra?: Record<string, unknown>): void {
      emit("error", service, msg, extra);
    },
  };
}

/** Reset internal state. For testing only. */
export function _resetLogDirState(): void {
  logDirInitialized = false;
}
