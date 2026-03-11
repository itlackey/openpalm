import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState, getState } from "$lib/server/state.js";
import { load } from "./+page.server.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir: string;
let originalConfigHome: string | undefined;
let originalStateHome: string | undefined;
let originalDataHome: string | undefined;

beforeEach(() => {
  rootDir = makeTempDir();
  originalConfigHome = process.env.OPENPALM_CONFIG_HOME;
  originalStateHome = process.env.OPENPALM_STATE_HOME;
  originalDataHome = process.env.OPENPALM_DATA_HOME;

  process.env.OPENPALM_CONFIG_HOME = join(rootDir, "config");
  process.env.OPENPALM_STATE_HOME = join(rootDir, "state");
  process.env.OPENPALM_DATA_HOME = join(rootDir, "data");
});

afterEach(() => {
  process.env.OPENPALM_CONFIG_HOME = originalConfigHome;
  process.env.OPENPALM_STATE_HOME = originalStateHome;
  process.env.OPENPALM_DATA_HOME = originalDataHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe("/setup page server load", () => {
  function makeLoadEvent(): Parameters<typeof load>[0] {
    return {} as Parameters<typeof load>[0];
  }

  test("returns detectedUserId but no setupToken", async () => {
    resetState();
    const result = await load(makeLoadEvent()) as Record<string, unknown>;

    // setupToken must NOT be exposed to the browser
    expect(result).not.toHaveProperty("setupToken");
    expect(typeof result.detectedUserId).toBe("string");
  });

  test("redirects to home when OPENPALM_SETUP_COMPLETE=true in stack.env", async () => {
    resetState();
    const state = getState();
    const artifactsDir = join(state.stateDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(artifactsDir, "stack.env"),
      "OPENPALM_SETUP_COMPLETE=true\n"
    );

    await expect(load(makeLoadEvent())).rejects.toMatchObject({
      status: 307,
      location: "/"
    });
  });
});
