import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, _resetLogDirState } from "./logger.ts";

const TEST_LOG_DIR = join(import.meta.dir, "__test_logs__");

function cleanLogDir() {
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true, force: true });
}

describe("logger file persistence", () => {
  beforeEach(() => {
    cleanLogDir();
    _resetLogDirState();
    process.env.LOG_DIR = TEST_LOG_DIR;
    process.env.LOG_LEVEL = "debug";
  });

  afterEach(() => {
    delete process.env.LOG_DIR;
    delete process.env.LOG_LEVEL;
    cleanLogDir();
    _resetLogDirState();
  });

  it("writes log entries to LOG_DIR/service.log", () => {
    const log = createLogger("test-svc");
    log.info("hello", { key: "value" });

    const logFile = join(TEST_LOG_DIR, "service.log");
    expect(existsSync(logFile)).toBe(true);

    const content = readFileSync(logFile, "utf8").trim();
    const entry = JSON.parse(content);
    expect(entry.service).toBe("test-svc");
    expect(entry.msg).toBe("hello");
    expect(entry.level).toBe("info");
    expect(entry.extra).toEqual({ key: "value" });
  });

  it("appends multiple entries as JSONL", () => {
    const log = createLogger("multi");
    log.info("one");
    log.warn("two");
    log.error("three");

    const lines = readFileSync(join(TEST_LOG_DIR, "service.log"), "utf8")
      .trim()
      .split("\n");
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).msg).toBe("one");
    expect(JSON.parse(lines[1]).msg).toBe("two");
    expect(JSON.parse(lines[2]).msg).toBe("three");
  });

  it("respects log level filtering for file output", () => {
    process.env.LOG_LEVEL = "warn";
    const log = createLogger("filtered");
    log.debug("skip");
    log.info("skip too");
    log.warn("keep");

    const logFile = join(TEST_LOG_DIR, "service.log");
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe("keep");
  });

  it("does not write to file when LOG_DIR is unset", () => {
    delete process.env.LOG_DIR;
    _resetLogDirState();
    const log = createLogger("nofile");
    log.info("nothing written");
    expect(existsSync(join(TEST_LOG_DIR, "service.log"))).toBe(false);
  });

  it("rotates the log file when it exceeds 50 MB", () => {
    mkdirSync(TEST_LOG_DIR, { recursive: true });
    const logFile = join(TEST_LOG_DIR, "service.log");
    // Write a file slightly over 50 MB
    const bigContent = "x".repeat(50 * 1024 * 1024 + 1);
    writeFileSync(logFile, bigContent);

    const log = createLogger("rotate");
    log.info("after rotation");

    expect(existsSync(`${logFile}.1`)).toBe(true);
    const rotatedSize = readFileSync(`${logFile}.1`).length;
    expect(rotatedSize).toBeGreaterThan(50 * 1024 * 1024);

    const newContent = readFileSync(logFile, "utf8").trim();
    expect(JSON.parse(newContent).msg).toBe("after rotation");
  });

  it("creates log directory if it does not exist", () => {
    const nested = join(TEST_LOG_DIR, "nested", "deep");
    process.env.LOG_DIR = nested;
    _resetLogDirState();

    const log = createLogger("mkdir");
    log.info("created");

    expect(existsSync(join(nested, "service.log"))).toBe(true);
  });
});
