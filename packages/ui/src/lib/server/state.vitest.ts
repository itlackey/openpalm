/**
 * Tests for state.ts — singleton control plane state.
 *
 * Verifies:
 * 1. getState returns a valid ControlPlaneState object
 * 2. getState returns the same instance on repeated calls (singleton)
 * 3. resetState creates a fresh state instance
 * 4. resetState accepts optional admin token
 */
import { describe, test, expect } from "vitest";
import { getState } from "./state.js";
import { resetState } from "./test-helpers.js";

describe("getState", () => {
  test("returns a ControlPlaneState with expected shape", () => {
    const state = resetState("test-password-12345");
    expect(state).toBeDefined();
    // Phase 4: adminToken/assistantToken were removed from ControlPlaneState;
    // the operator login secret now lives in process.env.OP_UI_LOGIN_PASSWORD.
    expect(process.env.OP_UI_LOGIN_PASSWORD).toBe("test-password-12345");
    expect(state.homeDir).toBeDefined();
    expect(state.configDir).toBeDefined();
    expect(state.stateDir).toBeDefined();
    expect(state.stashDir).toBeDefined();
    expect(state.cacheDir).toBeDefined();
    expect(state.stackDir).toBeDefined();
    expect(state.services).toBeDefined();
    expect(state.artifacts).toBeDefined();
    expect(state.audit).toEqual([]);
  });

  test("returns same instance on repeated calls (singleton pattern)", () => {
    resetState("singleton-test-12345");
    const a = getState();
    const b = getState();
    expect(a).toBe(b);
  });
});

describe("resetState", () => {
  test("creates a fresh state instance and seeds OP_UI_LOGIN_PASSWORD", () => {
    const state1 = resetState("password-a-12345");
    expect(process.env.OP_UI_LOGIN_PASSWORD).toBe("password-a-12345");

    const state2 = resetState("password-b-12345");
    expect(process.env.OP_UI_LOGIN_PASSWORD).toBe("password-b-12345");
    expect(state2).not.toBe(state1);
  });

  test("getState returns the reset state", () => {
    resetState("reset-verify-12345");
    expect(getState()).toBeDefined();
    expect(process.env.OP_UI_LOGIN_PASSWORD).toBe("reset-verify-12345");
  });

  test("initializes core services as stopped", () => {
    const state = resetState();
    for (const status of Object.values(state.services)) {
      expect(status).toBe("stopped");
    }
  });
});
