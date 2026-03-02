export type LogLevel = "debug" | "info" | "warn" | "error";

export function createLogger(service: string) {
  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, service, msg, ...(extra ? { extra } : {}) };
    (level === "error" || level === "warn" ? console.error : console.log)(JSON.stringify(entry));
  }
  return {
    info:  (msg: string, extra?: Record<string, unknown>) => log("info",  msg, extra),
    warn:  (msg: string, extra?: Record<string, unknown>) => log("warn",  msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log("error", msg, extra),
    debug: (msg: string, extra?: Record<string, unknown>) => log("debug", msg, extra),
  };
}
