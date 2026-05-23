/**
 * Tests for the akm vault helpers. The vault helpers spawn `akm vault set
 * <ref> <key>` and feed the secret VALUE on stdin (akm-cli >= 0.8.0).
 *
 * Tests gate on the akm CLI being on PATH so the suite stays green in
 * environments without akm installed.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ensureAkmUserVault,
  readAkmUserVaultFile,
  writeAkmVaultKey,
  deleteAkmVaultKey,
  AKM_USER_VAULT_REF,
} from "./akm-vault.js";
import type { ControlPlaneState } from "./types.js";

function makeState(homeDir: string): ControlPlaneState {
  return {
    homeDir,
    configDir: join(homeDir, "config"),
    stashDir: join(homeDir, "stash"),
    workspaceDir: join(homeDir, "workspace"),
    cacheDir: join(homeDir, "cache"),
    stateDir: join(homeDir, "state"),
    stackDir: join(homeDir, "stack"),
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


describe("writeAkmVaultKey", () => {
  let homeDir: string;
  let state: ControlPlaneState;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-akm-write-"));
    state = makeState(homeDir);
    mkdirSync(state.stashDir, { recursive: true });
    mkdirSync(`${state.stateDir}/cache/akm`, { recursive: true });
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


describe("AKM_USER_VAULT_REF", () => {
  it("exports the canonical akm ref string", () => {
    expect(AKM_USER_VAULT_REF).toBe("vault:user");
  });
});
