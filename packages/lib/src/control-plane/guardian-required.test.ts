/**
 * guardianRequired is THE deploy gate for the guardian: an ingress addon, a
 * guardian access toggle, or a remote tunnel targeting the guardian. These
 * pin each reason independently, plus the fail-toward-deployed posture for a
 * poisoned OP_REMOTE_TARGET (profile resolution must not start throwing over
 * a typo'd unrelated key).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardianRequired, guardianRequiredForEnv } from "./guardian-required.ts";
import { stackEnvFile } from "./home.ts";

describe("guardianRequiredForEnv", () => {
  test("false for an empty env — a fresh install deploys the assistant alone", () => {
    expect(guardianRequiredForEnv({})).toBe(false);
  });

  test("true for each guardian-ingress addon, false for non-ingress addons", () => {
    for (const addon of ["api", "discord", "slack", "gateway"]) {
      expect(guardianRequiredForEnv({ OP_ENABLED_ADDONS: addon })).toBe(true);
    }
    expect(guardianRequiredForEnv({ OP_ENABLED_ADDONS: "voice,ollama,paperclip" })).toBe(false);
  });

  test("true for either guardian access toggle", () => {
    expect(guardianRequiredForEnv({ OP_ACCESS_GUARDIAN: "true" })).toBe(true);
    expect(guardianRequiredForEnv({ OP_ACCESS_OPENAI_API: "true" })).toBe(true);
    expect(
      guardianRequiredForEnv({ OP_ACCESS_GUARDIAN: "false", OP_ACCESS_OPENAI_API: "false" }),
    ).toBe(false);
  });

  test("legacy bind inference still counts when no intent key is stored", () => {
    // readAccessToggles falls back to bind inference for rows that predate
    // the stored-intent keys; a restored backup with an open guardian bind
    // must keep its guardian deployed.
    expect(guardianRequiredForEnv({ OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0" })).toBe(true);
  });

  test("remote addon targeting the guardian is a reason; targeting the assistant is not", () => {
    expect(
      guardianRequiredForEnv({ OP_ENABLED_ADDONS: "remote", OP_REMOTE_TARGET: "guardian" }),
    ).toBe(true);
    expect(
      guardianRequiredForEnv({ OP_ENABLED_ADDONS: "remote", OP_REMOTE_TARGET: "both" }),
    ).toBe(true);
    expect(
      guardianRequiredForEnv({ OP_ENABLED_ADDONS: "remote", OP_REMOTE_TARGET: "assistant" }),
    ).toBe(false);
  });

  test("a poisoned OP_REMOTE_TARGET fails toward deployed, not toward a crash", () => {
    // The registry throws on an explicitly-invalid target (a hand edit). The
    // deploy gate must neither propagate that throw into every compose call
    // nor silently drop a front door the install was serving.
    expect(
      guardianRequiredForEnv({ OP_ENABLED_ADDONS: "remote", OP_REMOTE_TARGET: "bogus" }),
    ).toBe(true);
  });
});

describe("guardianRequired (file-backed)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("reads the stack env from the home", () => {
    const home = mkdtempSync(join(tmpdir(), "op-guardian-required-"));
    tmpDirs.push(home);
    const envPath = stackEnvFile(home);
    mkdirSync(join(envPath, ".."), { recursive: true });

    writeFileSync(envPath, "OP_ENABLED_ADDONS=gateway\n");
    expect(guardianRequired(home)).toBe(true);

    writeFileSync(envPath, "OP_ENABLED_ADDONS=voice\n");
    expect(guardianRequired(home)).toBe(false);
  });
});
