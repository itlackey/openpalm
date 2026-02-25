/**
 * Structured JSON logger for assistant plugins.
 *
 * Mirrors the API and output format of @openpalm/lib/shared/logger.ts so that
 * all services produce identical log lines for aggregation tooling.
 *
 * The assistant runtime does not have @openpalm/lib available, so this module
 * provides a local copy of the same contract.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

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

function getMinLevel(): LogLevel {
  if (process.env.DEBUG === "1") return "debug";
  const raw = process.env.LOG_LEVEL;
  if (raw && raw in LEVEL_PRIORITY) return raw as LogLevel;
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinLevel()];
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
