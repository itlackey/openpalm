import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetServerState, createTestDirLayout } from "./test-utils.ts";
import { DEFAULT_STATE } from "./setup-manager.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "openpalm-test-utils-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("resetServerState", () => {
  it("writes a correct first-boot setup-state.json", () => {
    withTempDir((dir) => {
      // Populate with a completed state
      const dataAdmin = join(dir, "data", "admin");
      mkdirSync(dataAdmin, { recursive: true });
      writeFileSync(
        join(dataAdmin, "setup-state.json"),
        JSON.stringify({ completed: true, steps: { welcome: true } }),
        "utf8"
      );

      resetServerState(dir);

      const content = readFileSync(
        join(dataAdmin, "setup-state.json"),
        "utf8"
      );
      const state = JSON.parse(content);
      expect(state.completed).toBe(false);
      expect(state.steps.welcome).toBe(false);
      expect(state.steps.profile).toBe(false);
      expect(state.steps.channels).toBe(false);
      expect(state.steps.security).toBe(false);
      expect(state.steps.healthCheck).toBe(false);
      expect(state.steps.serviceInstances).toBe(false);
      expect(state.accessScope).toBe("host");
      expect(state.enabledChannels).toEqual([]);
    });
  });

  it("removes generated state artifacts", () => {
    withTempDir((dir) => {
      const stateDir = join(dir, "state");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(join(dir, "config"), { recursive: true });

      const artifacts = [
        "docker-compose.yml",
        "docker-compose.yml.next",
        "caddy.json",
        "render-report.json",
        "system.env",
        ".env",
      ];
      for (const f of artifacts) {
        writeFileSync(join(stateDir, f), "dummy", "utf8");
      }

      resetServerState(dir);

      for (const f of artifacts) {
        expect(existsSync(join(stateDir, f))).toBe(false);
      }
    });
  });

  it("removes known service .env files", () => {
    withTempDir((dir) => {
      const stateDir = join(dir, "state");
      const services = [
        "gateway",
        "openmemory",
        "postgres",
        "qdrant",
        "assistant",
      ];
      for (const svc of services) {
        mkdirSync(join(stateDir, svc), { recursive: true });
        writeFileSync(join(stateDir, svc, ".env"), "SECRET=val", "utf8");
      }
      mkdirSync(join(dir, "config"), { recursive: true });

      resetServerState(dir);

      for (const svc of services) {
        expect(existsSync(join(stateDir, svc, ".env"))).toBe(false);
        // Directories themselves are preserved
        expect(existsSync(join(stateDir, svc))).toBe(true);
      }
    });
  });

  it("removes dynamically generated channel .env files", () => {
    withTempDir((dir) => {
      const stateDir = join(dir, "state");
      mkdirSync(join(stateDir, "channel-discord"), { recursive: true });
      mkdirSync(join(stateDir, "service-custom"), { recursive: true });
      writeFileSync(
        join(stateDir, "channel-discord", ".env"),
        "TOKEN=abc",
        "utf8"
      );
      writeFileSync(
        join(stateDir, "service-custom", ".env"),
        "KEY=xyz",
        "utf8"
      );
      mkdirSync(join(dir, "config"), { recursive: true });

      resetServerState(dir);

      expect(existsSync(join(stateDir, "channel-discord", ".env"))).toBe(
        false
      );
      expect(existsSync(join(stateDir, "service-custom", ".env"))).toBe(false);
      // Directories preserved
      expect(existsSync(join(stateDir, "channel-discord"))).toBe(true);
      expect(existsSync(join(stateDir, "service-custom"))).toBe(true);
    });
  });

  it("removes config artifacts", () => {
    withTempDir((dir) => {
      const configDir = join(dir, "config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "openpalm.yaml"), "spec: v1", "utf8");
      writeFileSync(
        join(configDir, "secrets.env"),
        "POSTGRES_PASSWORD=secret",
        "utf8"
      );

      resetServerState(dir);

      expect(existsSync(join(configDir, "openpalm.yaml"))).toBe(false);
      expect(existsSync(join(configDir, "secrets.env"))).toBe(false);
    });
  });

  it("is idempotent (calling twice does not error)", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "config"), { recursive: true });
      resetServerState(dir);
      resetServerState(dir); // second call should not throw

      const content = readFileSync(
        join(dir, "data", "admin", "setup-state.json"),
        "utf8"
      );
      const state = JSON.parse(content);
      expect(state.completed).toBe(false);
    });
  });

  it("works on a bare empty directory", () => {
    withTempDir((dir) => {
      // No subdirectories at all
      resetServerState(dir);

      const statePath = join(dir, "data", "admin", "setup-state.json");
      expect(existsSync(statePath)).toBe(true);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.completed).toBe(false);
    });
  });

  it("supports custom layout overrides", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".dev", "config"), { recursive: true });

      resetServerState(dir, {
        dataAdmin: ".dev/data/admin",
        stateRoot: ".dev/state",
        config: ".dev/config",
      });

      const statePath = join(dir, ".dev", "data", "admin", "setup-state.json");
      expect(existsSync(statePath)).toBe(true);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.completed).toBe(false);
    });
  });
});

describe("createTestDirLayout", () => {
  it("creates the expected directory tree with seed files", () => {
    let dir: string | null = null;
    try {
      dir = createTestDirLayout("openpalm-layout-test-");

      // Directories exist
      expect(existsSync(join(dir, "data", "admin"))).toBe(true);
      expect(existsSync(join(dir, "state"))).toBe(true);
      expect(existsSync(join(dir, "config"))).toBe(true);
      expect(existsSync(join(dir, "cron"))).toBe(true);
      expect(
        existsSync(
          join(dir, "data", "assistant", ".config", "opencode")
        )
      ).toBe(true);

      // Service directories
      for (const svc of [
        "gateway",
        "openmemory",
        "postgres",
        "qdrant",
        "assistant",
      ]) {
        expect(existsSync(join(dir, "state", svc))).toBe(true);
        expect(existsSync(join(dir, "state", svc, ".env"))).toBe(true);
      }

      // Seed files exist
      expect(existsSync(join(dir, "config", "secrets.env"))).toBe(true);
      expect(existsSync(join(dir, "state", ".env"))).toBe(true);
      expect(existsSync(join(dir, "state", "system.env"))).toBe(true);

      // opencode.json has expected content
      const ocContent = readFileSync(
        join(
          dir,
          "data",
          "assistant",
          ".config",
          "opencode",
          "opencode.json"
        ),
        "utf8"
      );
      expect(JSON.parse(ocContent)).toEqual({ plugin: [] });
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
});
