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
      for (const step of Object.keys(state.steps).filter((k) => k !== "accessScope")) {
        expect(state.steps[step as keyof typeof state.steps]).toBe(false);
      }
    });
  });
});

describe("SetupManager.setAccessScope", () => {
  for (const scope of ["host", "lan", "public"] as const) {
    it(`persists the "${scope}" scope`, () => {
      withTempDir((dir) => {
        const manager = new SetupManager(dir);
        manager.setAccessScope(scope);
        expect(manager.getState().accessScope).toBe(scope);
      });
    });
  }
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

// Test C (rec5.3): forward-compatibility — unknown fields in the persisted JSON
// must not cause isValidSetupState to fail, so known fields are read back intact.
describe("getState forward-compatibility (unknown fields)", () => {
  it("reads back all known fields correctly when state file contains an extra unknown field", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      // Write a fully-valid state with one extra field that a future version might add
      const futureState = {
        completed: true,
        completedAt: "2099-01-01T00:00:00.000Z",
        accessScope: "lan",
        serviceInstances: { openmemory: "http://mem:3000", psql: "", qdrant: "" },
        smallModel: { endpoint: "", modelId: "" },
        profile: { name: "Ada", email: "ada@example.com" },
        steps: {
          welcome: true,
          profile: true,
          accessScope: false,
          serviceInstances: false,
          healthCheck: false,
          security: false,
          channels: false,
          extensions: false,
        },
        enabledChannels: ["discord"],
        installedExtensions: [],
        // extra field that does not exist in the current SetupState type:
        futureFeatureFlag: true,
      };
      writeFileSync(
        join(dir, "setup-state.json"),
        JSON.stringify(futureState, null, 2),
        "utf8"
      );

      const state = manager.getState();
      // All known fields must survive the round-trip
      expect(state.completed).toBe(true);
      expect(state.accessScope).toBe("lan");
      expect(state.profile).toEqual({ name: "Ada", email: "ada@example.com" });
      expect(state.enabledChannels).toEqual(["discord"]);
      expect(state.steps.welcome).toBe(true);
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

  // Test B (rec5.2): idempotency — calling completeSetup a second time must not
  // throw, must keep completed=true, and must not clear previously-set step state.
  it("is idempotent — a second call keeps completed=true and preserves step state", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.completeStep("welcome");
      manager.completeSetup();
      // Second call — must not throw
      const state = manager.completeSetup();
      expect(state.completed).toBe(true);
      // The previously completed step must still be true
      expect(state.steps.welcome).toBe(true);
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

// Test A (rec5.1): setEnabledChannels deduplication — duplicate entries in the
// input array must be collapsed to unique values in the persisted state.
describe("SetupManager.setEnabledChannels", () => {
  it("deduplicates the channel list and persists only unique entries", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      const state = manager.setEnabledChannels(["discord", "telegram", "discord", "telegram", "chat"]);
      // Returned state must be deduplicated
      expect(state.enabledChannels).toEqual(["discord", "telegram", "chat"]);
      // Reloading from disk must also reflect the deduplicated list
      expect(manager.getState().enabledChannels).toEqual(["discord", "telegram", "chat"]);
    });
  });

  it("replaces any previously set channels (not additive)", () => {
    withTempDir((dir) => {
      const manager = new SetupManager(dir);
      manager.setEnabledChannels(["discord", "telegram"]);
      manager.setEnabledChannels(["chat"]);
      expect(manager.getState().enabledChannels).toEqual(["chat"]);
    });
  });
});
