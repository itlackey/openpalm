/**
 * Unit tests for the voice host-fact probes (2.2 — moved out of
 * packages/ui/.../voice/bring-up.ts). Both probes shell out to `docker info`;
 * these tests are environment-tolerant (they assert the return type + that
 * the call never throws) since a real Docker daemon may or may not be
 * reachable in CI/sandbox.
 */
import { describe, it, expect } from "bun:test";
import { detectRootlessDocker, dockerHasNvidiaRuntime } from "./voice-host-probes.js";

describe("detectRootlessDocker", () => {
  it("never throws and resolves to a boolean", async () => {
    const result = await detectRootlessDocker();
    expect(typeof result).toBe("boolean");
  });
});

describe("dockerHasNvidiaRuntime", () => {
  it("never throws and resolves to a boolean", async () => {
    const result = await dockerHasNvidiaRuntime();
    expect(typeof result).toBe("boolean");
  });
});
