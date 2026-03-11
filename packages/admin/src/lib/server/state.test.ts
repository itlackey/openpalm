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
import { getState, resetState } from "./state.js";

describe("getState", () => {
  test("returns a ControlPlaneState with expected shape", () => {
    const state = resetState("test-token");
    expect(state).toBeDefined();
    expect(state.adminToken).toBe("test-token");
    expect(state.stateDir).toBeDefined();
    expect(state.configDir).toBeDefined();
    expect(state.dataDir).toBeDefined();
    expect(state.services).toBeDefined();
    expect(state.artifacts).toBeDefined();
    expect(state.audit).toEqual([]);
  });

  test("returns same instance on repeated calls (singleton pattern)", () => {
    resetState("singleton-test");
    const a = getState();
    const b = getState();
    expect(a).toBe(b);
  });
});

describe("resetState", () => {
  test("creates fresh state with new token", () => {
    const state1 = resetState("token-a");
    expect(state1.adminToken).toBe("token-a");

    const state2 = resetState("token-b");
    expect(state2.adminToken).toBe("token-b");
    expect(state2).not.toBe(state1);
  });

  test("getState returns the reset state", () => {
    resetState("reset-verify");
    expect(getState().adminToken).toBe("reset-verify");
  });

  test("generates setupToken on each reset", () => {
    const state1 = resetState();
    const state2 = resetState();
    // setupTokens should be random and different
    expect(state1.setupToken).not.toBe(state2.setupToken);
  });

  test("initializes core services as stopped", () => {
    const state = resetState();
    for (const status of Object.values(state.services)) {
      expect(status).toBe("stopped");
    }
  });
});
