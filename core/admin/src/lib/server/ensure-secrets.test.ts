import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSecrets, type ControlPlaneState } from "./control-plane.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let configDir: string;

beforeEach(() => {
  configDir = makeTempDir();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("ensureSecrets", () => {
  test("seeds secrets.env with empty ADMIN_TOKEN on first run", () => {
    const state = {
      configDir,
      adminToken: "preconfigured-token"
    } as ControlPlaneState;

    ensureSecrets(state);

    const secrets = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(secrets).toContain("ADMIN_TOKEN=\n");
    expect(secrets).not.toContain("ADMIN_TOKEN=preconfigured-token");
  });
});
