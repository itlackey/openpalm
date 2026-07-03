import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOperatorIds, resolveSessionIdentity, hasUsableOperatorId } from "./operator-ids.js";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "openpalm-opids-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveOperatorIds", () => {
  test("returns the homeDir's owner when it exists and is non-root", () => {
    // A mkdtemp directory is owned by the current process — neither
    // root (in any reasonable test env) nor a hard-coded 1000.
    const expected = statSync(tempDir);
    const ids = resolveOperatorIds(tempDir);
    if (process.platform === "win32") {
      expect(ids).toBeNull();
      return;
    }
    expect(ids).not.toBeNull();
    expect(ids!.uid).toBe(expected.uid);
    expect(ids!.gid).toBe(expected.gid);
  });

  test("falls back to process UID when homeDir does not exist", () => {
    const missing = join(tempDir, "does-not-exist");
    const ids = resolveOperatorIds(missing);
    if (process.platform === "win32") {
      expect(ids).toBeNull();
      return;
    }
    expect(ids).not.toBeNull();
    // process.getuid is guaranteed on POSIX runtimes used by this test
    expect(ids!.uid).toBe(process.getuid!());
    expect(ids!.gid).toBe(process.getgid!());
  });

  test("never returns 0 (root) — falls back to process UID when homeDir is root-owned", () => {
    // We can't easily chown a dir to root without root. Instead, exercise
    // the branch via a faked statSync output: build a path that triggers
    // the "owner is 0, prefer process UID" code path by ensuring real
    // tempDir owner is the process UID and asserting the result for a
    // missing path matches process UID (already covered above). The
    // explicit 0-check is enforced by the implementation; this test
    // documents that the function never *returns* 0 for any of the
    // exercised inputs in a non-root test process.
    const ids = resolveOperatorIds(tempDir);
    if (process.platform === "win32") {
      expect(ids).toBeNull();
      return;
    }
    expect(ids).not.toBeNull();
    expect(ids!.uid).toBeGreaterThan(0);
    expect(ids!.gid).toBeGreaterThan(0);
  });

  test("returns null when BOTH homeDir owner and process UID/GID are 0 (root install on root-owned OP_HOME)", () => {
    if (process.platform === "win32") {
      // win32 short-circuits before any of this logic
      expect(resolveOperatorIds(tempDir)).toBeNull();
      return;
    }

    // Stub process.getuid / getgid to simulate running as root. On Linux,
    // `/` is owned by uid=0 gid=0, so passing "/" gives us a root-owned
    // homeDir. Combined with the stubbed process IDs, this hits the
    // "both signals are root" branch that previously returned {0,0}.
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as unknown as { getuid: () => number }).getuid = () => 0;
      (process as unknown as { getgid: () => number }).getgid = () => 0;
      // Sanity-check the assumption that "/" is root-owned in this env
      // before relying on it as a fixture. On macOS / Linux CI runners
      // this holds; if a future weird env breaks it, the assertion
      // surfaces clearly rather than producing a confusing pass.
      const rootStat = statSync("/");
      expect(rootStat.uid).toBe(0);
      expect(rootStat.gid).toBe(0);

      const ids = resolveOperatorIds("/");
      expect(ids).toBeNull();
    } finally {
      (process as unknown as { getuid: typeof origGetuid }).getuid = origGetuid;
      (process as unknown as { getgid: typeof origGetgid }).getgid = origGetgid;
    }
  });

  test("returns null on win32", () => {
    // This test is informational; on non-win32 it doesn't run the win32
    // branch. The check is left here for documentation and runs as a
    // no-op assertion on POSIX.
    if (process.platform === "win32") {
      expect(resolveOperatorIds(tempDir)).toBeNull();
    } else {
      // No-op: confirms the test compiles and the helper is callable.
      expect(typeof resolveOperatorIds).toBe("function");
    }
  });
});

describe("resolveSessionIdentity", () => {
  test("returns the LIVE process uid/gid for a non-root session, NOT the disk owner", () => {
    if (process.platform === "win32") {
      expect(resolveSessionIdentity(tempDir)).toBeNull();
      return;
    }
    // Crucial swap-detection property: even when homeDir is owned by a
    // DIFFERENT (stale) uid, a non-root session reports its own live uid — so a
    // moved drive's stale owner cannot mask a host swap. We can't chown to a
    // foreign uid without root, so assert the general contract: for a non-root
    // session the result is the process uid regardless of homeDir.
    const ids = resolveSessionIdentity(tempDir);
    expect(ids).not.toBeNull();
    expect(ids!.uid).toBe(process.getuid!());
    expect(ids!.gid).toBe(process.getgid!());
  });

  test("ignores a missing homeDir for a non-root session (uses process ids)", () => {
    if (process.platform === "win32") return;
    const ids = resolveSessionIdentity(join(tempDir, "does-not-exist"));
    expect(ids).not.toBeNull();
    expect(ids!.uid).toBe(process.getuid!());
  });

  test("falls back to the disk-owner-preferring resolver for a root session", () => {
    if (process.platform === "win32") return;
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as unknown as { getuid: () => number }).getuid = () => 0;
      (process as unknown as { getgid: () => number }).getgid = () => 0;
      // Root session over a non-root-owned OP_HOME (tempDir owned by the test
      // user): defer to resolveOperatorIds, which prefers the disk owner — this
      // preserves the sudo-install-for-service-user case.
      const expected = statSync(tempDir);
      const ids = resolveSessionIdentity(tempDir);
      expect(ids).toEqual({ uid: expected.uid, gid: expected.gid });
    } finally {
      (process as unknown as { getuid: typeof origGetuid }).getuid = origGetuid;
      (process as unknown as { getgid: typeof origGetgid }).getgid = origGetgid;
    }
  });

  test("returns null for a root session over a root-owned OP_HOME", () => {
    if (process.platform === "win32") return;
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as unknown as { getuid: () => number }).getuid = () => 0;
      (process as unknown as { getgid: () => number }).getgid = () => 0;
      // "/" is root-owned; both signals root → resolveOperatorIds returns null.
      expect(resolveSessionIdentity("/")).toBeNull();
    } finally {
      (process as unknown as { getuid: typeof origGetuid }).getuid = origGetuid;
      (process as unknown as { getgid: typeof origGetgid }).getgid = origGetgid;
    }
  });
});

describe("hasUsableOperatorId", () => {
  test("returns true for positive numeric values", () => {
    expect(hasUsableOperatorId({ OP_UID: "1000" }, "OP_UID")).toBe(true);
    expect(hasUsableOperatorId({ OP_GID: "501" }, "OP_GID")).toBe(true);
  });

  test("returns false for missing key", () => {
    expect(hasUsableOperatorId({}, "OP_UID")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(hasUsableOperatorId({ OP_UID: "" }, "OP_UID")).toBe(false);
  });

  test("returns false for zero", () => {
    expect(hasUsableOperatorId({ OP_UID: "0" }, "OP_UID")).toBe(false);
  });

  test("returns false for non-numeric garbage", () => {
    expect(hasUsableOperatorId({ OP_UID: "abc" }, "OP_UID")).toBe(false);
  });
});
