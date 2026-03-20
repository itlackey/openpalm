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

let rootDir: string;

beforeEach(() => {
  rootDir = makeTempDir();
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("ensureSecrets", () => {
  test("seeds user.env with default keys on first run", () => {
    const vaultDir = join(rootDir, "vault");
    mkdirSync(vaultDir, { recursive: true });

    const state = {
      configDir: join(rootDir, "config"),
      vaultDir,
      adminToken: "preconfigured-token"
    } as ControlPlaneState;

    ensureSecrets(state);

    const secrets = readFileSync(join(vaultDir, "user.env"), "utf-8");
    expect(secrets).toContain("OPENAI_API_KEY=");
    expect(secrets).toContain("EMBEDDING_MODEL=");
  });
});
