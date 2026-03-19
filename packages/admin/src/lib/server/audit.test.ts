/**
 * Tests for audit.ts — audit logging.
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  readFileSync,
  existsSync
} from "node:fs";
import { join } from "node:path";

import { appendAudit } from "./audit.js";
import type { ControlPlaneState } from "./types.js";
import { makeTestState, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

describe("appendAudit", () => {
  let state: ControlPlaneState;

  beforeEach(() => {
    state = makeTestState();
    trackDir(state.homeDir);
  });

  test("appends entry to in-memory audit array", () => {
    appendAudit(state, "admin", "install", { target: "stack" }, true, "req-1", "ui");
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].actor).toBe("admin");
    expect(state.audit[0].action).toBe("install");
    expect(state.audit[0].ok).toBe(true);
    expect(state.audit[0].requestId).toBe("req-1");
    expect(state.audit[0].callerType).toBe("ui");
  });

  test("includes ISO timestamp", () => {
    appendAudit(state, "admin", "test", {}, true);
    expect(state.audit[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("persists to JSONL file on disk", () => {
    appendAudit(state, "admin", "install", {}, true, "req-1");
    const auditFile = join(state.logsDir, "admin-audit.jsonl");
    expect(existsSync(auditFile)).toBe(true);
    const content = readFileSync(auditFile, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.action).toBe("install");
  });

  test("caps in-memory audit at 1000 entries (per MAX_AUDIT_MEMORY)", () => {
    for (let i = 0; i < 1050; i++) {
      appendAudit(state, "admin", `action-${i}`, {}, true);
    }
    expect(state.audit.length).toBe(1000);
    // Oldest entries should be trimmed; newest kept
    expect(state.audit[0].action).toBe("action-50");
    expect(state.audit[999].action).toBe("action-1049");
  });

  test("defaults requestId to empty string and callerType to unknown", () => {
    appendAudit(state, "admin", "test", {}, true);
    expect(state.audit[0].requestId).toBe("");
    expect(state.audit[0].callerType).toBe("unknown");
  });
});
