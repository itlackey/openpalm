/**
 * Tests for the akm vault mirror — Phase 2 of #388 (closes #406).
 *
 * The mirror now spawns `akm vault set <ref> <key>` and feeds the secret
 * VALUE on stdin (akm-cli >= 0.8.0). After mirror, the legacy
 * `vault/user/user.env` is deleted by `migrateAndCleanupLegacyUserEnv`
 * once every key is verified present in the akm vault.
 *
 * Tests gate on the akm CLI being on PATH so the suite stays green in
 * environments without akm installed. The pure logic (env file
 * enumeration, idempotency diff, argv-leak guard, cleanup pre-conditions)
 * is covered unconditionally via Bun.spawn stubs.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  mirrorUserVaultToAkm,
  ensureAkmUserVault,
  readAkmUserVaultFile,
  writeAkmVaultKey,
  deleteAkmVaultKey,
  migrateAndCleanupLegacyUserEnv,
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
    // Seed a pre-0.11 vault/user/user.env layout — exactly the shape
    // `applyUpgrade()` sees on the first 0.10.x → 0.11 upgrade.
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      "# legacy 0.10.x layout\nGROQ_API_KEY=xyz-test-value-1\nOWNER_NAME=Alice\n",
    );

    // First mirror — should write the keys via `akm vault set` (stdin mode).
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

    // The source .env file is still on disk — `mirrorUserVaultToAkm` is
    // mirror-only. `migrateAndCleanupLegacyUserEnv` performs the delete.
    expect(existsSync(join(state.vaultDir, "user", "user.env"))).toBe(true);

    // Second mirror — every key reported as unchanged (idempotent).
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

  it("never passes secret values via spawn argv (no /proc/cmdline leak) — mocked", async () => {
    // SECURITY INVARIANT — must run on every CI environment, even ones
    // without akm-cli on PATH. Phase 2 regression test for the security
    // finding on PR #404 / #421: every write must route through
    // `akm vault set <ref> <key>` with the value delivered via stdin.
    //
    // Strategy: stub `Bun.spawn` (and through it, the `child_process.execFile`
    // path used by `execAkm`, since Bun's execFile is implemented on top of
    // Bun.spawn). The stub records every argv + stdin write it observes and
    // synthesizes a believable akm response for each invocation — version
    // probe, vault create, vault path, vault set. Then we replay the
    // production write path (`mirrorUserVaultToAkm`) and assert:
    //   1. The secret value never appears on any argv element.
    //   2. The secret value DID arrive via stdin on the `vault set` call.
    //   3. The `vault set` invocation requested a stdin pipe.
    const secret = "secret-payload-12345-do-not-leak";
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      `LEAK_CHECK_KEY=${secret}\n`,
    );

    const argvCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    const stdinWrites: string[] = [];
    let stdinPipedOnSet = false;

    const originalSpawn = Bun.spawn;

    // Bun.spawn is called two ways inside akm-vault.ts:
    //   1. From `akmVaultSetViaStdin`: `Bun.spawn(argv, opts)` directly.
    //   2. From `execAkm` via `child_process.execFile`: Bun's execFile shim
    //      calls `Bun.spawn({ cmd, stdio, env, onExit, ... })` with a
    //      single options object. The onExit callback drives the
    //      promisified execFile resolution — the spawn return value's
    //      `exited` Promise is NOT awaited by execFile, so we MUST invoke
    //      `opts.onExit(child, exitCode, signalCode, error)` to unblock it.
    //
    // The dispatcher below normalises both call shapes, records argv
    // (security-relevant), captures stdin writes, and synthesises a
    // believable response per akm subcommand.
    function fakeChild(exitCode: number, stdoutText: string, wantsStdin: boolean) {
      const stdinSink = wantsStdin
        ? {
            write: (chunk: string | Buffer) => {
              stdinWrites.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
              return Promise.resolve();
            },
            end: () => Promise.resolve(),
            flush: () => Promise.resolve(),
          }
        : null;
      return {
        pid: 12345,
        exited: Promise.resolve(exitCode),
        exitCode,
        signalCode: null,
        killed: false,
        stdin: stdinSink,
        stdout: new Response(stdoutText).body,
        stderr: new Response("").body,
        kill: () => {},
        ref: () => {},
        unref: () => {},
        [Symbol.asyncDispose]: async () => {},
        resourceUsage: () => undefined,
      };
    }

    function responseFor(argv: readonly string[]) {
      // akm --version → availability probe success
      if (argv[0] === "akm" && argv[1] === "--version") {
        return { exitCode: 0, stdout: "akm 0.8.0-rc2\n" };
      }
      // akm vault create vault:user → idempotent success
      if (argv[0] === "akm" && argv[1] === "vault" && argv[2] === "create") {
        return { exitCode: 0, stdout: "" };
      }
      // akm vault path vault:user → return a deterministic path
      if (argv[0] === "akm" && argv[1] === "vault" && argv[2] === "path") {
        return { exitCode: 0, stdout: `${state.dataDir}/stash/vaults/user.env\n` };
      }
      // akm vault set vault:user <key> → must pipe stdin and never carry value on argv
      if (argv[0] === "akm" && argv[1] === "vault" && argv[2] === "set") {
        return { exitCode: 0, stdout: "" };
      }
      return { exitCode: 0, stdout: "" };
    }

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((arg1: unknown, arg2?: unknown) => {
      // Normalise: direct (argv, opts) vs object form ({ cmd, ... }) used by
      // the node:child_process.execFile shim in Bun.
      let argv: string[];
      let wantsStdin = false;
      let onExit: ((child: unknown, code: number, signal: unknown, err: unknown) => void) | undefined;
      if (Array.isArray(arg1)) {
        argv = arg1 as string[];
        const opts = (arg2 ?? {}) as Record<string, unknown>;
        wantsStdin = opts.stdin === "pipe";
      } else {
        const opts = arg1 as Record<string, unknown>;
        argv = (opts?.cmd as string[] | undefined) ?? [];
        const stdio = opts?.stdio as unknown[] | undefined;
        // execFile's spawn opts use stdio: ["pipe", "pipe", "pipe"] — the
        // first slot is stdin. The akm-vault stdin-write path uses the
        // direct argv form and sets stdin: "pipe" explicitly, so this
        // branch never wants stdin capture.
        wantsStdin = Array.isArray(stdio) && stdio[0] === "pipe" && argv[1] === "vault" && argv[2] === "set";
        onExit = opts?.onExit as typeof onExit;
      }

      argvCalls.push({ cmd: argv[0] ?? "", args: argv.slice(1) });

      const { exitCode, stdout } = responseFor(argv);
      if (argv[0] === "akm" && argv[1] === "vault" && argv[2] === "set" && wantsStdin) {
        stdinPipedOnSet = true;
      }
      const child = fakeChild(exitCode, stdout, wantsStdin);

      // execFile path: drive resolution via onExit. Use queueMicrotask so
      // the caller has a chance to attach handlers.
      if (onExit) {
        queueMicrotask(() => {
          try { onExit!(child, exitCode, null, null); } catch { /* swallow */ }
        });
      }
      return child as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    try {
      const result = await mirrorUserVaultToAkm(state);
      expect(result.ok).toBe(true);
      // The mirror should have written the key (mock claims success).
      expect(result.written).toContain("LEAK_CHECK_KEY");

      // SECURITY ASSERTION (1): the secret value MUST NOT appear on any
      // observed argv across every spawn we intercepted.
      for (const call of argvCalls) {
        for (const arg of call.args) {
          expect(arg).not.toContain(secret);
        }
      }

      // SECURITY ASSERTION (2): the value DID transit through stdin —
      // proving the production write path used the stdin channel rather
      // than argv. Concatenate writes in case the sink was called multiple
      // times.
      expect(stdinWrites.join("")).toContain(secret);

      // POSITIVE: at least one `akm vault set` invocation requested a
      // stdin pipe — i.e. the value path used stdin, not argv.
      expect(stdinPipedOnSet).toBe(true);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  it.skipIf(!AKM_AVAILABLE)("never passes secret values via Bun.spawn argv (no /proc/cmdline leak) — live akm sanity", async () => {
    // Live sanity check against the real akm binary. The mocked test above
    // is the unconditional security gate; this one verifies the contract
    // also holds end-to-end on environments that have akm installed.
    const secret = "secret-payload-12345-do-not-leak";
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      `LEAK_CHECK_KEY=${secret}\n`,
    );

    const argvCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    let stdinPiped = false;
    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: unknown, opts?: Record<string, unknown>) => {
      const argv = Array.isArray(cmd) ? (cmd as string[]) : [String(cmd)];
      argvCalls.push({ cmd: argv[0] ?? "", args: argv.slice(1) });
      if (argv[0] === "akm" && argv[1] === "vault" && argv[2] === "set" && opts?.stdin === "pipe") {
        stdinPiped = true;
      }
      return (originalSpawn as (...a: unknown[]) => unknown)(cmd, opts) as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    try {
      const result = await mirrorUserVaultToAkm(state);
      expect(result.ok).toBe(true);

      for (const call of argvCalls) {
        for (const arg of call.args) {
          expect(arg).not.toContain(secret);
        }
      }

      expect(stdinPiped).toBe(true);

      const vaultPath = `${state.dataDir}/stash/vaults/user.env`;
      expect(existsSync(vaultPath)).toBe(true);
      const stored = readAkmUserVaultFile(vaultPath);
      expect(stored.LEAK_CHECK_KEY).toBe(secret);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
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

  it.skipIf(!AKM_AVAILABLE)("writes a key via `akm vault set` (stdin mode, no argv leak)", async () => {
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

  it.skipIf(!AKM_AVAILABLE)("deleteAkmVaultKey removes a key via `akm vault unset`", async () => {
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

  it.skipIf(!AKM_AVAILABLE)("deleteAkmVaultKey is idempotent on a missing key", async () => {
    // Deleting a key that was never set should not throw — `akm vault unset`
    // either exits 0 or emits a "not found" message we tolerate.
    const ok = await deleteAkmVaultKey(state, "NEVER_SET_KEY");
    expect(ok).toBe(true);
  });
});

describe("migrateAndCleanupLegacyUserEnv", () => {
  let homeDir: string;
  let state: ControlPlaneState;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-akm-cleanup-"));
    state = makeState(homeDir);
    mkdirSync(join(state.vaultDir, "user"), { recursive: true });
    mkdirSync(join(state.dataDir, "stash"), { recursive: true });
    mkdirSync(join(state.dataDir, "akm-cache"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("reports already-absent when no legacy file exists", async () => {
    const result = await migrateAndCleanupLegacyUserEnv(state);
    expect(result.deleted).toBe(false);
    expect(result.reason).toBe("user.env already absent");
  });

  it("deletes an empty placeholder user.env without invoking akm", async () => {
    writeFileSync(join(state.vaultDir, "user", "user.env"), "# placeholder only\nEMPTY=\n");
    const result = await migrateAndCleanupLegacyUserEnv(state);
    expect(result.deleted).toBe(true);
    expect(existsSync(join(state.vaultDir, "user", "user.env"))).toBe(false);
  });

  it.skipIf(!AKM_AVAILABLE)("end-to-end: mirror then cleanup deletes the legacy file", async () => {
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      "MIGRATE_KEY=migrated-value\nOWNER_NAME=Alice\n",
    );

    const mirror = await mirrorUserVaultToAkm(state);
    expect(mirror.ok).toBe(true);
    expect(mirror.written.sort()).toEqual(["MIGRATE_KEY", "OWNER_NAME"]);

    const cleanup = await migrateAndCleanupLegacyUserEnv(state);
    expect(cleanup.deleted).toBe(true);
    expect(existsSync(join(state.vaultDir, "user", "user.env"))).toBe(false);

    // The akm vault still has the migrated keys after cleanup.
    const vaultPath = await ensureAkmUserVault(state);
    expect(vaultPath).not.toBeNull();
    if (vaultPath) {
      const stored = readAkmUserVaultFile(vaultPath);
      expect(stored.MIGRATE_KEY).toBe("migrated-value");
      expect(stored.OWNER_NAME).toBe("Alice");
    }
  });

  it("retains the legacy file when akm is unavailable (operator can re-run)", async () => {
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      "REAL_KEY=real-value\n",
    );

    // Stub Bun.spawn so akm appears unavailable.
    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => ({
      pid: 0,
      exited: Promise.resolve(127),
      exitCode: 127,
      signalCode: null,
      killed: false,
      stdin: null,
      stdout: new Response("").body,
      stderr: new Response("akm: command not found").body,
      kill: () => {},
      ref: () => {},
      unref: () => {},
      [Symbol.asyncDispose]: async () => {},
      resourceUsage: () => undefined,
    })) as unknown as typeof Bun.spawn;

    try {
      const cleanup = await migrateAndCleanupLegacyUserEnv(state);
      expect(cleanup.deleted).toBe(false);
      expect(cleanup.reason).toBe("akm not on PATH");
      // Legacy file MUST still exist so the upgrade is re-runnable once
      // akm is fixed.
      expect(existsSync(join(state.vaultDir, "user", "user.env"))).toBe(true);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });
});

describe("AKM_USER_VAULT_REF", () => {
  it("exports the canonical akm ref string", () => {
    expect(AKM_USER_VAULT_REF).toBe("vault:user");
  });
});
