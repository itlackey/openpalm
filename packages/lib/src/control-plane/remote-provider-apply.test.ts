/**
 * The provider-apply dispatcher's shared half: the forwarded-address env
 * reconciliation that keeps the login throttle per-client behind a remote
 * sidecar (remote-provider-apply.ts). The provider-specific half
 * (applyRemoteAccess) has its own suite in remote-apply.test.ts; these
 * tests pin what the DISPATCHER adds on top — the env flip, its recreate
 * scope, and its idempotence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyRemoteProviderConfig } from "./remote-provider-apply.js";

let home: string;

function stackEnvPath(): string {
  return join(home, "state", "stack.env");
}

function seedStackEnv(content: string): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(stackEnvPath(), content);
}

function readStackEnvRaw(): string {
  return readFileSync(stackEnvPath(), "utf-8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "remote-provider-apply-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("forwarded-address env reconciliation", () => {
  test("enabling remote sets the forwarded-address keys and recreates the assistant once", () => {
    seedStackEnv("OP_ENABLED_ADDONS=remote\n");

    const first = applyRemoteProviderConfig(home);
    expect(first.error).toBeUndefined();
    expect(first.services).toContain("tunnel");
    expect(first.services).toContain("assistant");
    expect(readStackEnvRaw()).toContain("OP_UI_ADDRESS_HEADER=x-forwarded-for");
    expect(readStackEnvRaw()).toContain("OP_UI_XFF_DEPTH=1");

    // Idempotent: a second apply with nothing changed must not keep
    // recreating the assistant (a remote CONFIG save never should).
    const second = applyRemoteProviderConfig(home);
    expect(second.error).toBeUndefined();
    expect(second.services).not.toContain("assistant");
  });

  test("disabling remote clears the keys — a forged X-Forwarded-For from a direct LAN client must not key the throttle", () => {
    seedStackEnv(
      "OP_ENABLED_ADDONS=\nOP_UI_ADDRESS_HEADER=x-forwarded-for\nOP_UI_XFF_DEPTH=1\n",
    );

    const result = applyRemoteProviderConfig(home);
    expect(result.error).toBeUndefined();
    expect(result.services).toContain("assistant");
    expect(readStackEnvRaw()).toContain("OP_UI_ADDRESS_HEADER=\n");
    expect(readStackEnvRaw()).toContain("OP_UI_XFF_DEPTH=\n");
    // Disabled remote deploys nothing, so no tunnel recreate either.
    expect(result.services).not.toContain("tunnel");
  });
});
