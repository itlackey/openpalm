import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSecrets, readSecret, type ControlPlaneState } from "@openpalm/lib";

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
  test("seeds non-secret stack env and file-based system secrets on first run", () => {
    const stackDir = join(rootDir, "config", "stack");
    mkdirSync(stackDir, { recursive: true });

    const state = {
      configDir: join(rootDir, "config"),
      stackDir,
    } as ControlPlaneState;

    ensureSecrets(state);

    const stackEnv = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(stackEnv).toContain("OP_SETUP_COMPLETE=false");
    expect(stackEnv).not.toContain("OPENAI_API_KEY=");
    expect(stackEnv).not.toContain("OP_UI_LOGIN_PASSWORD=");
    expect(readSecret(stackDir, "op_ui_login_password")).toBeTruthy();
  });

  test("applies strict permissions to state files", () => {
    const stackDir = join(rootDir, "config", "stack");
    const state = {
      configDir: join(rootDir, "config"),
      stackDir,
    } as ControlPlaneState;

    ensureSecrets(state);

    expect(statSync(stackDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stackDir, "stack.env")).mode & 0o777).toBe(0o600);
  });
});
