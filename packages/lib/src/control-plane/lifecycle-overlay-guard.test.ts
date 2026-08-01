/**
 * Regression tests: the channel_lan overlay-deprecation guard's per-kind
 * behavior (review-564 c9, as revised by the PR #564 retest P2-3 — the
 * ratified semantics recorded in CHANGELOG.md's unreleased section).
 *
 * `applyManagedFiles` (lifecycle.ts) runs `checkCustomComposeChannelLan`
 * before snapshotting or writing anything. Its `blockError` case hard-blocks
 * every flow that reaches `applyManagedFiles` — install, update, and upgrade
 * — so the operator gets the pre-write migration instruction instead of a
 * late post-write Compose failure. Only uninstall is exempt: `applyUninstall`
 * never calls `applyManagedFiles` (it goes straight to `reconcileCore`), so a
 * stale overlay can never prevent tearing the stack down.
 *
 * An earlier review round (c9, r3566892768) demoted the update case to a
 * warning; the P2-3 retest deliberately re-blocked update too. These tests
 * pin the P2-3 split — no test guarded it before, and one refactor
 * (75989ca) already rewrote this code path without coverage.
 *
 * Fixture and assertions mirror overlay-deprecations.test.ts's "blocks when
 * channel_lan is referenced but not defined" case. Runs the real
 * applyInstall/applyUpdate/applyUninstall entry points end-to-end (no mocks)
 * against a throwaway OP_HOME, the same way setup.test.ts's `performSetup`
 * suite does — the skip flags keep Docker-backed compose preflight and
 * ownership reconciliation (unrelated concerns) out of the picture.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyInstall, applyUninstall, applyUpdate, createState } from "./lifecycle.js";
import type { ControlPlaneState } from "./types.js";

// Same fixture shape as overlay-deprecations.test.ts:69-82 — a service that
// references channel_lan without defining it itself (blockError case, not
// the self-defined-network warning case).
const STALE_OVERLAY =
  "services:\n  legacy:\n    image: example:latest\n    networks:\n      - channel_lan\n";

let homeDir: string;
let state: ControlPlaneState;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "openpalm-overlay-guard-"));

  savedEnv.OP_HOME = process.env.OP_HOME;
  savedEnv.OP_SKIP_COMPOSE_PREFLIGHT = process.env.OP_SKIP_COMPOSE_PREFLIGHT;
  savedEnv.OP_SKIP_OWNERSHIP_RECONCILE = process.env.OP_SKIP_OWNERSHIP_RECONCILE;
  process.env.OP_HOME = homeDir;
  process.env.OP_SKIP_COMPOSE_PREFLIGHT = "1";
  process.env.OP_SKIP_OWNERSHIP_RECONCILE = "1";

  state = createState();

  mkdirSync(join(homeDir, "config", "stack"), { recursive: true });
  writeFileSync(join(homeDir, "config", "stack", "custom.compose.yml"), STALE_OVERLAY);
});

afterEach(() => {
  if (savedEnv.OP_HOME === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedEnv.OP_HOME;
  if (savedEnv.OP_SKIP_COMPOSE_PREFLIGHT === undefined) delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
  else process.env.OP_SKIP_COMPOSE_PREFLIGHT = savedEnv.OP_SKIP_COMPOSE_PREFLIGHT;
  if (savedEnv.OP_SKIP_OWNERSHIP_RECONCILE === undefined) delete process.env.OP_SKIP_OWNERSHIP_RECONCILE;
  else process.env.OP_SKIP_OWNERSHIP_RECONCILE = savedEnv.OP_SKIP_OWNERSHIP_RECONCILE;
  rmSync(homeDir, { recursive: true, force: true });
});

async function expectBlocked(run: Promise<void>): Promise<void> {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).toContain("channel_lan");
  expect(message).toContain("portal_net");
  expect(message.toLowerCase()).toContain("nothing was changed");
}

describe("channel_lan overlay guard blocks activation AND update, exempts uninstall (PR #564 retest P2-3)", () => {
  test("applyInstall hard-blocks on a stale channel_lan overlay reference", async () => {
    await expectBlocked(applyInstall(state));
  });

  test("applyUpdate hard-blocks too, before any managed write", async () => {
    await expectBlocked(applyUpdate(state));
    // Pre-write: the managed system/ tree must not have been materialized.
    expect(existsSync(join(homeDir, "system"))).toBe(false);
  });

  test("applyUninstall completes despite a stale channel_lan overlay reference", async () => {
    const result = await applyUninstall(state);
    expect(result).toEqual({ stopped: [] });
  });
});
