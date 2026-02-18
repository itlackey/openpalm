import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

  it("persists selected channels as unique service ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-setup-"));
    try {
      const manager = new SetupManager(dir);
      manager.setEnabledChannels(["channel-chat", "channel-chat", "channel-discord"]);
      const state = manager.getState();
      expect(state.enabledChannels).toEqual(["channel-chat", "channel-discord"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to defaults when setup-state.json is corrupted", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-setup-"));
    try {
      const manager = new SetupManager(dir);
      writeFileSync(join(dir, "setup-state.json"), "{broken-json", "utf8");
      const state = manager.getState();
      expect(state.completed).toBe(false);
      expect(state.accessScope).toBe("host");
      expect(state.serviceInstances).toEqual({ openmemory: "", psql: "", qdrant: "" });
      expect(state.enabledChannels).toEqual([]);
      expect(state.installedExtensions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes malformed persisted values instead of crashing or preserving invalid shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-setup-"));
    try {
      const manager = new SetupManager(dir);
      writeFileSync(join(dir, "setup-state.json"), JSON.stringify({
        completed: "yes",
        accessScope: "internet",
        serviceInstances: { openmemory: ["bad"], psql: 123, qdrant: "http://qdrant:6333" },
        steps: { welcome: "true", channels: true },
        enabledChannels: ["chat", 7],
        installedExtensions: "not-an-array"
      }, null, 2), "utf8");

      const state = manager.getState();
      expect(state.completed).toBe(false);
      expect(state.accessScope).toBe("host");
      expect(state.serviceInstances).toEqual({ openmemory: "", psql: "", qdrant: "http://qdrant:6333" });
      expect(state.steps.welcome).toBe(false);
      expect(state.steps.channels).toBe(true);
      expect(state.enabledChannels).toEqual(["chat"]);
      expect(state.installedExtensions).toEqual([]);

      state.completed = true;
      manager.save(state);
      const saved = JSON.parse(readFileSync(join(dir, "setup-state.json"), "utf8")) as { completed: boolean };
      expect(saved.completed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
