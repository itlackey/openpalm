import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupManager } from "./setup.ts";

describe("SetupManager service instance configuration", () => {
  it("defaults service instance values for first boot state", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-setup-"));
    try {
      const manager = new SetupManager(dir);
      const state = manager.getState();
      expect(state.serviceInstances).toEqual({ openmemory: "", psql: "", qdrant: "" });
      expect(state.steps.serviceInstances).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists updated service instance values", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-setup-"));
    try {
      const manager = new SetupManager(dir);
      manager.setServiceInstances({ openmemory: "http://existing-openmemory:3000", psql: "postgresql://db", qdrant: "http://qdrant:6333" });
      const state = manager.getState();
      expect(state.serviceInstances).toEqual({
        openmemory: "http://existing-openmemory:3000",
        psql: "postgresql://db",
        qdrant: "http://qdrant:6333",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
