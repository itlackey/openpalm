/**
 * Tests for validateProposedState().
 *
 * Post-#391 the validator no longer shells out to varlock. It reads the live
 * `vault/stack/stack.env` and `vault/user/user.env` files directly and emits
 * presence-based errors/warnings. These tests stub the on-disk files and
 * assert the resulting shape.
 */
import { describe, test, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { validateProposedState } from "@openpalm/lib";
import { makeTestState, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

function seedStack(stateDir: string, env: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "stack.env"), env);
}

describe("validateProposedState", () => {
  test("ok=true when required keys are present", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    seedStack(state.stateDir, "OP_ADMIN_TOKEN=abc\nOP_ASSISTANT_TOKEN=def\n");

    const result = await validateProposedState(state);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("ok=false when stack.env is missing", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    // No stack.env at all
    const result = await validateProposedState(state);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("stack env file missing");
  });

  test("ok=false when OP_ADMIN_TOKEN is empty", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    seedStack(state.stateDir, "OP_ADMIN_TOKEN=\nOP_ASSISTANT_TOKEN=def\n");

    const result = await validateProposedState(state);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("OP_ADMIN_TOKEN"))).toBe(true);
  });

  test("warns about missing optional canonical slots", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    seedStack(state.stateDir, "OP_ADMIN_TOKEN=abc\nOP_ASSISTANT_TOKEN=def\n");

    const result = await validateProposedState(state);
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    // Warning text includes the env key
    expect(result.warnings.some((w) => w.includes("OPENAI_API_KEY"))).toBe(true);
  });
});
