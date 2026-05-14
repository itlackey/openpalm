/**
 * Tests for the akm vault mirror (Phase 1 of #388).
 *
 * The full mirror requires the `akm` CLI on PATH plus a writable shared
 * stash directory. Tests gate on those conditions so the suite stays
 * green in environments without akm installed. The pure logic (env
 * file enumeration, idempotency diff) is covered unconditionally.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  mirrorUserVaultToAkm,
  ensureAkmUserVault,
  readAkmUserVaultFile,
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

  it.skipIf(!AKM_AVAILABLE)("migrates a fake 0.10.x layout idempotently", async () => {
    // Seed a pre-0.11 user.env with a single key.
    writeFileSync(
      join(state.vaultDir, "user", "user.env"),
      "# legacy 0.10.x layout\nGROQ_API_KEY=xyz-test-value-1\n",
    );

    // First mirror — should write the key.
    const first = await mirrorUserVaultToAkm(state);
    expect(first.ok).toBe(true);
    expect(first.skipped).toBe(false);
    expect(first.written).toContain("GROQ_API_KEY");
    expect(first.unchanged).toHaveLength(0);

    // The akm vault file should now contain the value.
    const vaultPath = await ensureAkmUserVault(state);
    expect(vaultPath).not.toBeNull();
    if (vaultPath) {
      const stored = readAkmUserVaultFile(vaultPath);
      expect(stored.GROQ_API_KEY).toBe("xyz-test-value-1");
    }

    // The source .env file MUST still exist (Phase 1 keeps both in sync).
    expect(existsSync(join(state.vaultDir, "user", "user.env"))).toBe(true);
    expect(readFileSync(join(state.vaultDir, "user", "user.env"), "utf-8"))
      .toContain("GROQ_API_KEY=xyz-test-value-1");

    // Second mirror — every key should now be reported as unchanged.
    const second = await mirrorUserVaultToAkm(state);
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(false);
    expect(second.unchanged).toContain("GROQ_API_KEY");
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
});

describe("AKM_USER_VAULT_REF", () => {
  it("exports the canonical akm ref string", () => {
    expect(AKM_USER_VAULT_REF).toBe("vault:user");
  });
});
