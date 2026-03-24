import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSecrets, type ControlPlaneState } from "@openpalm/lib";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir: string;

beforeEach(() => {
  rootDir = makeTempDir();
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("ensureSecrets", () => {
  test("seeds vault env files with default keys on first run", () => {
    const vaultDir = join(rootDir, "vault");
    mkdirSync(vaultDir, { recursive: true });

    const state = {
      configDir: join(rootDir, "config"),
      vaultDir,
      adminToken: "preconfigured-token"
    } as ControlPlaneState;

    ensureSecrets(state);

    const stackEnv = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(stackEnv).toContain("OPENAI_API_KEY=");
    expect(stackEnv).toContain("OWNER_NAME=");
    expect(stackEnv).toContain("OP_ADMIN_TOKEN=");
    expect(stackEnv).toContain("OP_ASSISTANT_TOKEN=");
    expect(stackEnv).toContain("OP_MEMORY_TOKEN=");
    expect(existsSync(join(vaultDir, "user", "user.env"))).toBe(true);
  });

  test("applies strict permissions to vault files", () => {
    const vaultDir = join(rootDir, "vault");
    const state = {
      configDir: join(rootDir, "config"),
      vaultDir,
      adminToken: "preconfigured-token"
    } as ControlPlaneState;

    ensureSecrets(state);

    expect(statSync(vaultDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(vaultDir, "user", "user.env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(vaultDir, "stack", "stack.env")).mode & 0o777).toBe(0o600);
  });
});
