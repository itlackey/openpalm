/**
 * Lightweight structured JSON logger.
 *
 * Usage:
 *   import { createLogger } from "@openpalm/lib/shared/logger.ts";
 *   const log = createLogger("admin");
 *   log.info("server started", { port: 8100 });
 *   // => {"ts":"2026-02-21T...","level":"info","service":"admin","msg":"server started","extra":{"port":8100}}
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

function isDebugEnabled(): boolean {
  return Bun.env.LOG_LEVEL === "debug" || Bun.env.DEBUG === "1";
}

function emit(level: LogLevel, service: string, msg: string, extra?: Record<string, unknown>): void {
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
      if (!isDebugEnabled()) return;
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
