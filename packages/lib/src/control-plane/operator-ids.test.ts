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
    expect(ids?.uid).toBe(expected.uid);
    expect(ids?.gid).toBe(expected.gid);
  });

  test("falls back to process UID when homeDir does not exist", () => {
    const missing = join(tempDir, "does-not-exist");
    const ids = resolveOperatorIds(missing);
    if (process.platform === "win32") {
      expect(ids).toBeNull();
      return;
    }
    expect(ids).not.toBeNull();
    // process.getuid/getgid are guaranteed on the POSIX runtimes used by this
    // test (the win32 branch returned early above), so the calls never throw.
    // biome-ignore lint/style/noNonNullAssertion: process.getuid is defined on POSIX (win32 returned early).
    expect(ids?.uid).toBe(process.getuid!());
    // biome-ignore lint/style/noNonNullAssertion: process.getgid is defined on POSIX (win32 returned early).
    expect(ids?.gid).toBe(process.getgid!());
  });

  test("prefers a non-root owner over root — root is a last resort, not the default", () => {
    const ids = resolveOperatorIds(tempDir);
    if (process.platform === "win32") {
      expect(ids).toBeNull();
      return;
    }
    expect(ids).not.toBeNull();
    // The mkdtemp dir is owned by this process, so the answer is the process
    // identity whether or not that happens to be root. What this pins is the
    // PRECEDENCE: a non-root signal always wins over a root one (covered
    // explicitly by the stubbed-root cases below).
    const expected = statSync(tempDir);
    expect(ids?.uid).toBe(expected.uid);
    expect(ids?.gid).toBe(expected.gid);
  });

  test("prefers a non-root PROCESS uid over a root-owned homeDir", () => {
    if (process.platform === "win32") return;
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as unknown as { getuid: () => number }).getuid = () => 4242;
      (process as unknown as { getgid: () => number }).getgid = () => 4243;
      // "/" is root-owned, so the non-root process identity must win.
      const ids = resolveOperatorIds("/");
      expect(ids).toEqual({ uid: 4242, gid: 4243 });
    } finally {
      (process as unknown as { getuid: typeof origGetuid }).getuid = origGetuid;
      (process as unknown as { getgid: typeof origGetgid }).getgid = origGetgid;
    }
  });

  test("reports root when BOTH homeDir owner and process are root (root install)", () => {
    if (process.platform === "win32") {
      expect(resolveOperatorIds(tempDir)).toBeNull();
      return;
    }

    // Simulate a root install: stubbed root process ids plus "/", which is
    // root-owned on Linux/macOS. This used to return null, which let compose's
    // ${OP_UID:-1000} default apply — containers then ran as 1000 against a
    // root-owned OP_HOME and could not write, silently. Root installs are
    // supported (with a warning from the caller), so the truth is reported.
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as unknown as { getuid: () => number }).getuid = () => 0;
      (process as unknown as { getgid: () => number }).getgid = () => 0;
      const rootStat = statSync("/");
      expect(rootStat.uid).toBe(0);
      expect(rootStat.gid).toBe(0);

      expect(resolveOperatorIds("/")).toEqual({ uid: 0, gid: 0 });
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
    // process.getuid/getgid are defined on POSIX (win32 returned early above).
    // biome-ignore lint/style/noNonNullAssertion: process.getuid is defined on POSIX (win32 returned early).
    expect(ids?.uid).toBe(process.getuid!());
    // biome-ignore lint/style/noNonNullAssertion: process.getgid is defined on POSIX (win32 returned early).
    expect(ids?.gid).toBe(process.getgid!());
  });

  test("ignores a missing homeDir for a non-root session (uses process ids)", () => {
    if (process.platform === "win32") return;
    const ids = resolveSessionIdentity(join(tempDir, "does-not-exist"));
    expect(ids).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: process.getuid is defined on POSIX (win32 returned early).
    expect(ids?.uid).toBe(process.getuid!());
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

  test("reports root for a root session over a root-owned OP_HOME", () => {
    if (process.platform === "win32") return;
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as unknown as { getuid: () => number }).getuid = () => 0;
      (process as unknown as { getgid: () => number }).getgid = () => 0;
      // "/" is root-owned; both signals root → root is the honest answer.
      // Ownership repair and swap detection then operate on real ids instead
      // of no-opping on a null, which is what left root installs unwritable.
      expect(resolveSessionIdentity("/")).toEqual({ uid: 0, gid: 0 });
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

  test("returns true for zero — a hand-set OP_UID=0 is an explicit root choice", () => {
    expect(hasUsableOperatorId({ OP_UID: "0" }, "OP_UID")).toBe(true);
  });

  test("returns false for negative or non-integer values", () => {
    expect(hasUsableOperatorId({ OP_UID: "-1" }, "OP_UID")).toBe(false);
    expect(hasUsableOperatorId({ OP_UID: "1.5" }, "OP_UID")).toBe(false);
  });

  test("returns false for non-numeric garbage", () => {
    expect(hasUsableOperatorId({ OP_UID: "abc" }, "OP_UID")).toBe(false);
  });
});
