/**
 * Whether this machine hosts a stack is RECORDED, not inferred.
 *
 * The routing that reads it has to tell "runs a stack here" from "talks to a
 * stack elsewhere". Deriving that from disk is what produced the trap this
 * record ends: the managed system/ tree is re-seeded on every launch, so a
 * machine that had installed nothing looked mid-install forever.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isSetupComplete, readHostEnabled, recordHostEnabled } from "./setup-status.js";

let home = "";

function writeStackEnv(content: string): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "stack.env"), content);
}

const stackEnv = (): string => readFileSync(join(home, "state", "stack.env"), "utf-8");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "op-setup-status-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("readHostEnabled", () => {
  it("is false for a machine that has never been set up", () => {
    expect(readHostEnabled(home)).toBe(false);
  });

  it("is false when the key is present but blank — the fallback seed", () => {
    writeStackEnv("OP_HOST_ENABLED=\n");
    expect(readHostEnabled(home)).toBe(false);
  });

  it("is true once an install records it", () => {
    writeStackEnv("OP_HOST_ENABLED=true\n");
    expect(readHostEnabled(home)).toBe(true);
  });

  it("only an exact 'true' counts", () => {
    for (const value of ["True", "TRUE", "1", "yes", "on"]) {
      writeStackEnv(`OP_HOST_ENABLED=${value}\n`);
      expect(readHostEnabled(home), `${value} must not read as a host`).toBe(false);
    }
  });

  // This clause is why the change needs no migration: every install that
  // predates the flag already carries the canonical completion record.
  it("recognises an install that predates the flag", () => {
    writeStackEnv("OP_SETUP_COMPLETE=true\n");
    expect(readHostEnabled(home)).toBe(true);
  });

  // A seeded-but-never-installed home is the case the whole record exists for.
  it("does not treat an unfinished install as a host", () => {
    writeStackEnv("OP_SETUP_COMPLETE=false\n");
    expect(readHostEnabled(home)).toBe(false);
  });
});

describe("recordHostEnabled", () => {
  it("records the fact", () => {
    writeStackEnv("OP_SETUP_COMPLETE=false\n");
    recordHostEnabled(home);
    expect(readHostEnabled(home)).toBe(true);
  });

  it("leaves neighbouring keys alone", () => {
    writeStackEnv("OP_SETUP_COMPLETE=false\nOP_ENABLED_ADDONS=voice\nOP_UI_PORT=3800\n");
    recordHostEnabled(home);

    const next = stackEnv();
    expect(next).toContain("OP_ENABLED_ADDONS=voice");
    expect(next).toContain("OP_UI_PORT=3800");
    // Hosting a stack and having finished setting one up are separate facts;
    // recording the first must not claim the second.
    expect(isSetupComplete(home)).toBe(false);
  });

  it("is idempotent", () => {
    writeStackEnv("OP_SETUP_COMPLETE=false\n");
    recordHostEnabled(home);
    const first = stackEnv();
    recordHostEnabled(home);
    expect(stackEnv()).toBe(first);
  });
});
