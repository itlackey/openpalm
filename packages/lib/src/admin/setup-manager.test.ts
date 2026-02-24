import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupManager } from "./setup-manager.ts";

// Helper: create a temp directory, run the test body, then clean up regardless
// of success or failure.
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "openpalm-setup-manager-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("SetupManager.getState", () => {
  it("returns default state when no state file exists", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      const state = manager.getState();
      expect(state.completed).toBe(false);
      expect(state.accessScope).toBe("host");
      expect(state.serviceInstances).toEqual({ openmemory: "", psql: "", qdrant: "" });
      expect(state.smallModel).toEqual({ endpoint: "", modelId: "" });
      expect(state.profile).toEqual({ name: "", email: "" });
      expect(state.enabledChannels).toEqual([]);
      expect(state.installedExtensions).toEqual([]);
      expect(state.steps).toEqual({
        welcome: false,
        profile: false,
        accessScope: false,
        serviceInstances: false,
        healthCheck: false,
        security: false,
        channels: false,
        extensions: false,
      });
    });
  });
});

describe("SetupManager.completeStep", () => {
  it("marks the specified step as complete and persists it", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      const state = manager.completeStep("welcome");
      expect(state.steps.welcome).toBe(true);
      // Reload from disk to confirm persistence
      const reloaded = manager.getState();
      expect(reloaded.steps.welcome).toBe(true);
    });
  });

  it("only marks the targeted step; all others remain false", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.completeStep("accessScope");
      const state = manager.getState();
      expect(state.steps.accessScope).toBe(true);
      expect(state.steps.welcome).toBe(false);
      expect(state.steps.profile).toBe(false);
      expect(state.steps.serviceInstances).toBe(false);
      expect(state.steps.healthCheck).toBe(false);
      expect(state.steps.security).toBe(false);
      expect(state.steps.channels).toBe(false);
      expect(state.steps.extensions).toBe(false);
    });
  });
});

describe("SetupManager.setAccessScope", () => {
  it('persists the "host" scope', () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.setAccessScope("host");
      expect(manager.getState().accessScope).toBe("host");
    });
  });

  it('persists the "lan" scope', () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.setAccessScope("lan");
      expect(manager.getState().accessScope).toBe("lan");
    });
  });

  it('persists the "public" scope', () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.setAccessScope("public");
      expect(manager.getState().accessScope).toBe("public");
    });
  });
});

describe("getState validation (regression: scope handling)", () => {
  it('preserves "public" scope when read back from disk', () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.setAccessScope("public");
      // Force a fresh read through the normalizeState path
      const reloaded = manager.getState();
      expect(reloaded.accessScope).toBe("public");
    });
  });

  it('defaults to "host" when state has an invalid scope value', () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      // Write a state file with a scope value that is not in the allowed set
      writeFileSync(
        join(dir, "setup-state.json"),
        JSON.stringify({ accessScope: "internet" }, null, 2),
        "utf8"
      );
      const state = manager.getState();
      expect(state.accessScope).toBe("host");
    });
  });

  it('defaults to "host" when state is missing required fields', () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      writeFileSync(
        join(dir, "setup-state.json"),
        JSON.stringify({ completed: false }, null, 2),
        "utf8"
      );
      const state = manager.getState();
      expect(state.accessScope).toBe("host");
    });
  });
});

describe("getState validation (corrupt file handling)", () => {
  it("returns default state when file contains invalid JSON", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "setup-state.json"), "not valid json{{{", "utf8");
      const manager = new SetupManager(dir);
      const state = manager.getState();
      expect(state.completed).toBe(false);
      expect(state.accessScope).toBe("host");
      expect(state.enabledChannels).toEqual([]);
    });
  });

  it("returns default state when file has wrong structure", () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, "setup-state.json"),
        JSON.stringify({ completed: "yes", accessScope: 42 }),
        "utf8"
      );
      const manager = new SetupManager(dir);
      const state = manager.getState();
      expect(state.completed).toBe(false);
      expect(state.accessScope).toBe("host");
    });
  });
});

describe("SetupManager.setServiceInstances", () => {
  it("persists all three service instance values", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.setServiceInstances({
        openmemory: "http://openmemory:3000",
        psql: "postgresql://user:pass@db:5432/openpalm",
        qdrant: "http://qdrant:6333",
      });
      const state = manager.getState();
      expect(state.serviceInstances).toEqual({
        openmemory: "http://openmemory:3000",
        psql: "postgresql://user:pass@db:5432/openpalm",
        qdrant: "http://qdrant:6333",
      });
    });
  });

  it("merges a partial update without overwriting untouched fields", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.setServiceInstances({ openmemory: "http://openmemory:3000" });
      manager.setServiceInstances({ qdrant: "http://qdrant:6333" });
      const state = manager.getState();
      expect(state.serviceInstances.openmemory).toBe("http://openmemory:3000");
      expect(state.serviceInstances.qdrant).toBe("http://qdrant:6333");
      expect(state.serviceInstances.psql).toBe("");
    });
  });
});

describe("SetupManager.completeSetup", () => {
  it("sets completed to true and records a completedAt timestamp", () => {
    withTempDir((dir) => {
      const before = new Date();
      const manager = new SetupManager(dir);
      const state = manager.completeSetup();
      const after = new Date();

      expect(state.completed).toBe(true);
      expect(typeof state.completedAt).toBe("string");

      const ts = new Date(state.completedAt as string);
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  it("persists completed status when read back from disk", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.completeSetup();
      expect(manager.getState().completed).toBe(true);
    });
  });
});

describe("SetupManager.isFirstBoot", () => {
  it("returns true when the state file does not exist yet", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      expect(manager.isFirstBoot()).toBe(true);
    });
  });

  it("returns false once any state has been saved", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.completeStep("welcome");
      expect(manager.isFirstBoot()).toBe(false);
    });
  });
});


describe("SetupManager.setProfile", () => {
  it("persists name and email", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.setProfile({ name: "Taylor", email: "taylor@example.com" });
      expect(manager.getState().profile).toEqual({
        name: "Taylor",
        email: "taylor@example.com",
      });
    });
  });
});
