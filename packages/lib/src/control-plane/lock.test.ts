/**
 * Tests for orchestrator lock — acquisition, contention, stale cleanup,
 * corrupt file handling, release, and idempotent release.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireLock,
  releaseLock,
  lockPath,
  LockAcquisitionError,
} from "./lock.js";
import type { LockHandle, LockInfo } from "./lock.js";

let opHome: string;

beforeEach(() => {
  opHome = mkdtempSync(join(tmpdir(), "lock-test-"));
  mkdirSync(join(opHome, "data"), { recursive: true });
});

afterEach(() => {
  rmSync(opHome, { recursive: true, force: true });
});

// ── Acquisition ──────────────────────────────────────────────────────────

describe("acquireLock", () => {
  it("creates a lock file with correct JSON content", () => {
    const handle = acquireLock(opHome, "install");
    expect(existsSync(handle.path)).toBe(true);

    const content = JSON.parse(readFileSync(handle.path, "utf-8"));
    expect(content.pid).toBe(process.pid);
    expect(content.operation).toBe("install");
    expect(typeof content.acquiredAt).toBe("string");

    releaseLock(handle);
  });

  it("returns a handle with correct info", () => {
    const handle = acquireLock(opHome, "update");
    expect(handle.info.pid).toBe(process.pid);
    expect(handle.info.operation).toBe("update");
    expect(handle.path).toBe(lockPath(opHome));

    releaseLock(handle);
  });

  it("places lock at {opHome}/data/.openpalm.lock", () => {
    const handle = acquireLock(opHome, "test");
    expect(handle.path).toBe(join(opHome, "data", ".openpalm.lock"));
    releaseLock(handle);
  });
});

// ── Contention ───────────────────────────────────────────────────────────

describe("contention", () => {
  it("throws LockAcquisitionError when lock is already held by this process", () => {
    const handle = acquireLock(opHome, "install");

    try {
      expect(() => acquireLock(opHome, "update")).toThrow(LockAcquisitionError);
    } finally {
      releaseLock(handle);
    }
  });

  it("error includes holder details", () => {
    const handle = acquireLock(opHome, "install");

    try {
      acquireLock(opHome, "update");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LockAcquisitionError);
      const lockErr = err as LockAcquisitionError;
      expect(lockErr.holder.pid).toBe(process.pid);
      expect(lockErr.holder.operation).toBe("install");
    } finally {
      releaseLock(handle);
    }
  });
});

// ── Stale PID cleanup ────────────────────────────────────────────────────

describe("stale PID cleanup", () => {
  it("cleans up stale lock from a dead PID and acquires", () => {
    // Write a lock file with a PID that does not exist
    const stalePid = 99999999; // Very unlikely to be a real process
    const staleInfo: LockInfo = {
      pid: stalePid,
      operation: "old-install",
      acquiredAt: "2020-01-01T00:00:00.000Z",
    };
    writeFileSync(lockPath(opHome), JSON.stringify(staleInfo) + "\n");

    // Should succeed because the PID is dead
    const handle = acquireLock(opHome, "new-install");
    expect(handle.info.pid).toBe(process.pid);
    expect(handle.info.operation).toBe("new-install");

    releaseLock(handle);
  });
});

// ── Corrupt file handling ────────────────────────────────────────────────

describe("corrupt lock file", () => {
  it("recovers from a corrupt lock file", () => {
    writeFileSync(lockPath(opHome), "not valid json{{{");

    const handle = acquireLock(opHome, "install");
    expect(handle.info.pid).toBe(process.pid);

    releaseLock(handle);
  });

  it("recovers from an empty lock file", () => {
    writeFileSync(lockPath(opHome), "");

    const handle = acquireLock(opHome, "install");
    expect(handle.info.pid).toBe(process.pid);

    releaseLock(handle);
  });

  it("recovers from a lock file with missing fields", () => {
    writeFileSync(lockPath(opHome), JSON.stringify({ pid: 1 }));

    const handle = acquireLock(opHome, "install");
    expect(handle.info.pid).toBe(process.pid);

    releaseLock(handle);
  });
});

// ── Release ──────────────────────────────────────────────────────────────

describe("releaseLock", () => {
  it("removes the lock file", () => {
    const handle = acquireLock(opHome, "install");
    expect(existsSync(handle.path)).toBe(true);

    releaseLock(handle);
    expect(existsSync(handle.path)).toBe(false);
  });

  it("is idempotent — second release is a no-op", () => {
    const handle = acquireLock(opHome, "install");
    releaseLock(handle);
    expect(existsSync(handle.path)).toBe(false);

    // Second release should not throw
    releaseLock(handle);
    expect(existsSync(handle.path)).toBe(false);
  });

  it("does not remove lock owned by a different PID", () => {
    // Simulate a lock file owned by someone else
    const otherInfo: LockInfo = {
      pid: 99999999,
      operation: "other",
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(lockPath(opHome), JSON.stringify(otherInfo) + "\n");

    // Create a handle that claims to own the lock
    const fakeHandle: LockHandle = {
      path: lockPath(opHome),
      info: {
        pid: process.pid, // Different from file content
        operation: "mine",
        acquiredAt: new Date().toISOString(),
      },
    };

    releaseLock(fakeHandle);
    // Lock file should still exist because PID doesn't match
    expect(existsSync(lockPath(opHome))).toBe(true);
  });
});

// ── lockPath ─────────────────────────────────────────────────────────────

describe("lockPath", () => {
  it("returns the correct path", () => {
    expect(lockPath("/home/user/.openpalm")).toBe("/home/user/.openpalm/data/.openpalm.lock");
  });
});
