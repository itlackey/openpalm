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
  test("seeds state env files with default keys on first run", () => {
    const stackDir = join(rootDir, "config", "stack");
    mkdirSync(stackDir, { recursive: true });

    const state = {
      configDir: join(rootDir, "config"),
      stackDir,
    } as ControlPlaneState;

    ensureSecrets(state);

    const stackEnv = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(stackEnv).toContain("OPENAI_API_KEY=");
    expect(stackEnv).toContain("OWNER_NAME=");
    expect(stackEnv).toContain("OP_UI_LOGIN_PASSWORD=");
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
