/**
 * Tests for the akm vault mirror (Phase 1 of #388).
 *
 * The full mirror requires the `akm` CLI on PATH plus a writable shared
 * stash directory. Tests gate on those conditions so the suite stays
 * green in environments without akm installed. The pure logic (env
 * file enumeration, idempotency diff) is covered unconditionally.
 *
 * CI coverage gap: the gated tests `it.skipIf(!AKM_AVAILABLE)` skip
 * silently when akm is not on PATH. CI does not install akm today, so
 * these branches are exercised only by local developers. Follow-up
 * tracked in the PR body.
 */
import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import {
  mirrorUserVaultToAkm,
  ensureAkmUserVault,
  readAkmUserVaultFile,
  writeAkmVaultKey,
  deleteAkmVaultKey,
  AKM_USER_VAULT_REF,
} from "./akm-vault.js";
import type { ControlPlaneState } from "./types.js";

function makeState(homeDir: string): ControlPlaneState {
  return {
    adminToken: "test-admin",
    assistantToken: "test-assistant",
    setupToken: "test-setup",
    homeDir,
    configDir: join(homeDir, "config"),
    vaultDir: join(homeDir, "vault"),
    dataDir: join(homeDir, "data"),
    logsDir: join(homeDir, "logs"),
    cacheDir: join(homeDir, ".cache"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
    audit: [],
  };
}

function hasAkmCli(): boolean {
  try {
    execFileSync("akm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const AKM_AVAILABLE = hasAkmCli();

describe("mirrorUserVaultToAkm", () => {
  let homeDir: string;
  let state: ControlPlaneState;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-akm-"));
    state = makeState(homeDir);
    mkdirSync(state.vaultDir, { recursive: true });
    mkdirSync(join(state.vaultDir, "user"), { recursive: true });
    mkdirSync(state.dataDir, { recursive: true });
    mkdirSync(join(state.dataDir, "stash"), { recursive: true });
    mkdirSync(join(state.dataDir, "akm-cache"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("skips when user.env is missing", async () => {
    const result = await mirrorUserVaultToAkm(state);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("user.env missing");
  });

  it("skips when user.env contains no non-empty values", async () => {
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      "# comments only\n\n# another comment\nEMPTY_KEY=\n",
    );
    const result = await mirrorUserVaultToAkm(state);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("user.env empty");
  });

  it.skipIf(!AKM_AVAILABLE)("migrates a fake 0.10.x layout idempotently (upgrade-path contract)", async () => {
    // Seed a pre-0.11 vault/user/user.env layout — this is exactly the
    // shape `applyUpgrade()` sees on the first 0.10.x → 0.11 upgrade.
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      "# legacy 0.10.x layout\nGROQ_API_KEY=xyz-test-value-1\nOWNER_NAME=Alice\n",
    );

    // First mirror — should write the keys (this is the operation
    // `applyUpgrade()` performs after `refreshCoreAssets`+`reconcileCore`).
    const first = await mirrorUserVaultToAkm(state);
    expect(first.ok).toBe(true);
    expect(first.skipped).toBe(false);
    expect(first.written.sort()).toEqual(["GROQ_API_KEY", "OWNER_NAME"]);
    expect(first.unchanged).toHaveLength(0);

    // The akm vault file should now contain the values.
    const vaultPath = await ensureAkmUserVault(state);
    expect(vaultPath).not.toBeNull();
    expect(vaultPath).toContain("vaults/user.env");
    if (vaultPath) {
      const stored = readAkmUserVaultFile(vaultPath);
      expect(stored.GROQ_API_KEY).toBe("xyz-test-value-1");
      expect(stored.OWNER_NAME).toBe("Alice");
    }

    // The source .env file MUST still exist (Phase 1 keeps both in sync
    // — Compose env_file consumption stays on user.env until Phase 2).
    expect(existsSync(join(state.vaultDir, "user", "user.env"))).toBe(true);
    expect(readFileSync(join(state.vaultDir, "user", "user.env"), "utf-8"))
      .toContain("GROQ_API_KEY=xyz-test-value-1");

    // Second mirror — every key should now be reported as unchanged
    // (proves the upgrade is idempotent on re-run).
    const second = await mirrorUserVaultToAkm(state);
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(false);
    expect(second.unchanged.sort()).toEqual(["GROQ_API_KEY", "OWNER_NAME"]);
    expect(second.written).toHaveLength(0);
  });

  it.skipIf(!AKM_AVAILABLE)("updates only changed keys on second run", async () => {
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      "KEY_A=value-a\nKEY_B=value-b\n",
    );
    await mirrorUserVaultToAkm(state);

    // Change KEY_B, leave KEY_A untouched.
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      "KEY_A=value-a\nKEY_B=value-b-updated\n",
    );
    const result = await mirrorUserVaultToAkm(state);
    expect(result.written).toEqual(["KEY_B"]);
    expect(result.unchanged).toEqual(["KEY_A"]);
  });

  it("returns a skipped result (does not hang) when the child process never resolves", async () => {
    // Regression test for the install/upgrade hang reproduced on PR #404:
    // `mirrorUserVaultToAkm` previously awaited promisified `execFile` without
    // a wall-clock bound. In environments where the child process never
    // resolves stdout (e.g. Bun test suites in `packages/cli/src/main.test.ts`
    // that stub `Bun.spawn` and return a fake child whose stdout/exit never
    // fire), the mirror would block the entire install flow until the
    // surrounding test timed out. This test pins the contract: even with a
    // permanently-pending child, the mirror must abort fast and report a
    // skip rather than hang.
    //
    // We stub `Bun.spawn` (the actual primitive under `child_process.execFile`
    // in the Bun runtime) the same way `packages/cli/src/main.test.ts`
    // `mockDockerCli` does, to faithfully reproduce the original failure mode.
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      "STUCK_CHECK=value-1\n",
    );

    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => ({
      pid: 0,
      exited: new Promise<number>(() => { /* never resolves */ }),
      exitCode: null,
      signalCode: null,
      killed: false,
      stdin: null,
      stdout: null,
      stderr: null,
      kill: () => {},
      ref: () => {},
      unref: () => {},
      [Symbol.asyncDispose]: async () => {},
      resourceUsage: () => undefined,
    })) as unknown as typeof Bun.spawn;

    try {
      const start = Date.now();
      const result = await mirrorUserVaultToAkm(state);
      const elapsed = Date.now() - start;

      // Mirror must abandon the akm probe and return — never block install.
      // The internal AKM_EXEC_TIMEOUT_MS is 2s; allow generous CI headroom.
      expect(elapsed).toBeLessThan(4_000);
      // Timeout is treated as "akm not on PATH" — best-effort skip, never throw.
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  it.skipIf(!AKM_AVAILABLE)("never passes secret values via execFile argv (no /proc/cmdline leak)", async () => {
    // This is the regression test for the security finding on PR #404.
    // Spy on execFile and assert no call contains the secret value.
    const secret = "secret-payload-12345-do-not-leak";
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      `LEAK_CHECK_KEY=${secret}\n`,
    );

    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spy = spyOn(childProcess, "execFile").mockImplementation(
      ((command: string, args: readonly string[], _options: unknown, cb?: unknown) => {
        calls.push({ command, args });
        // Fake `akm --version` so akmAvailable() returns true. For any
        // other invocation, fake success with a stdout suitable for the
        // caller (e.g. `vault path` returns the vault file path).
        let stdout = "";
        if (args[0] === "--version") {
          stdout = "0.8.0\n";
        } else if (args[0] === "vault" && args[1] === "path") {
          stdout = `${state.dataDir}/stash/vaults/user.env\n`;
        }
        const callback = cb as ((err: unknown, result: { stdout: string; stderr: string }) => void) | undefined;
        if (callback) callback(null, { stdout, stderr: "" });
        return undefined as unknown as ReturnType<typeof childProcess.execFile>;
      }) as typeof childProcess.execFile,
    );

    try {
      const result = await mirrorUserVaultToAkm(state);
      expect(result.ok).toBe(true);

      // No execFile call may include the secret value anywhere on argv.
      for (const call of calls) {
        for (const arg of call.args) {
          expect(arg).not.toContain(secret);
        }
      }

      // The vault file should still have been written by the direct-write path.
      const vaultPath = `${state.dataDir}/stash/vaults/user.env`;
      // Direct-write path created the file under stash; verify the value lives there.
      if (existsSync(vaultPath)) {
        const stored = readFileSync(vaultPath, "utf-8");
        expect(stored).toContain(`LEAK_CHECK_KEY=${secret}`);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("writeAkmVaultKey", () => {
  let homeDir: string;
  let state: ControlPlaneState;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-akm-write-"));
    state = makeState(homeDir);
    mkdirSync(join(state.dataDir, "stash"), { recursive: true });
    mkdirSync(join(state.dataDir, "akm-cache"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it.skipIf(!AKM_AVAILABLE)("writes a key to the akm vault file without invoking `akm vault set`", async () => {
    const value = "argv-free-secret-9988";
    const ok = await writeAkmVaultKey(state, "TOKEN", value);
    expect(ok).toBe(true);

    const vaultPath = await ensureAkmUserVault(state);
    expect(vaultPath).not.toBeNull();
    if (vaultPath) {
      const stored = readAkmUserVaultFile(vaultPath);
      expect(stored.TOKEN).toBe(value);
    }
  });

  it.skipIf(!AKM_AVAILABLE)("deleteAkmVaultKey removes a key", async () => {
    await writeAkmVaultKey(state, "TOKEN_A", "value-a");
    await writeAkmVaultKey(state, "TOKEN_B", "value-b");

    const ok = await deleteAkmVaultKey(state, "TOKEN_A");
    expect(ok).toBe(true);

    const vaultPath = await ensureAkmUserVault(state);
    if (vaultPath) {
      const stored = readAkmUserVaultFile(vaultPath);
      expect(stored.TOKEN_A).toBeUndefined();
      expect(stored.TOKEN_B).toBe("value-b");
    }
  });
});

describe("AKM_USER_VAULT_REF", () => {
  it("exports the canonical akm ref string", () => {
    expect(AKM_USER_VAULT_REF).toBe("vault:user");
  });
});
