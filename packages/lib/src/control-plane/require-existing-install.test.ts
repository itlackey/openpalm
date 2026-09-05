/**
 * (#684) `requireExistingInstall` — fail closed before an existing-install
 * operation touches Docker or writes to a managed home.
 *
 * The defect this guards: a wrong OP_HOME (a typo, or an unset variable falling
 * through to a default nothing was installed to) reads as a valid EMPTY install,
 * so the operation reports "no version rows" instead of "that path is not a
 * home" and the user debugs the wrong thing.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NotAnOpenPalmHomeError, requireExistingInstall } from "./launch-status.js";

describe("requireExistingInstall", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "require-install-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function stackDir(): string {
    const sd = join(dir, "system", "stack");
    mkdirSync(sd, { recursive: true });
    return sd;
  }
  function writeStackEnv(content: string): void {
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "stack.env"), content);
  }

  it("rejects a home that was never installed to", () => {
    expect(() => requireExistingInstall(dir)).toThrow(NotAnOpenPalmHomeError);
  });

  it("rejects an unrelated directory — the typo'd-OP_HOME case", () => {
    const unrelated = mkdtempSync(join(tmpdir(), "not-openpalm-"));
    writeFileSync(join(unrelated, "README.md"), "# some other project\n");
    try {
      expect(() => requireExistingInstall(unrelated)).toThrow(NotAnOpenPalmHomeError);
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
    }
  });

  it("names the resolved path, so the report is about the path and not the install", () => {
    let caught: unknown;
    try { requireExistingInstall(dir); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NotAnOpenPalmHomeError);
    expect((caught as NotAnOpenPalmHomeError).home).toBe(dir);
    expect((caught as Error).message).toBe(`Not an OpenPalm home: ${dir}`);
  });

  // The managed system/ tree is re-seeded on every launch, so a bare
  // core.compose.yml proves nothing — the classifier already treats it as
  // not_installed and the guard must inherit that, or every desktop launch on
  // a machine with no install would start passing.
  it("rejects a home carrying only the seeded compose file", () => {
    writeFileSync(join(stackDir(), "core.compose.yml"), "services: {}");
    expect(() => requireExistingInstall(dir)).toThrow(NotAnOpenPalmHomeError);
  });

  it("accepts a completed install and returns the home it validated", () => {
    stackDir();
    writeStackEnv("OP_SETUP_COMPLETE=true\n");
    expect(requireExistingInstall(dir)).toBe(dir);
  });

  // The setup_incomplete and legacy-env acceptance cases live beside the
  // classifier fixtures they mirror in launch-status.test.ts. Both files reach
  // the same code; keeping those two there avoids a second copy of the same
  // fixtures, and this file stays focused on what the GUARD adds over the
  // classifier: the refusal, and the message that names the path.
});
