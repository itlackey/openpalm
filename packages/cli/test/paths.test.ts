import { describe, expect, it } from "bun:test";
import { resolveXDGPaths, createDirectoryTree } from "@openpalm/lib/paths.ts";
import { stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("paths", () => {
  describe("resolveXDGPaths", () => {
    it("returns an object with data, config, state keys", () => {
      const paths = resolveXDGPaths();
      expect(paths).toHaveProperty("data");
      expect(paths).toHaveProperty("config");
      expect(paths).toHaveProperty("state");
    });

    it("all paths end with openpalm (without env overrides)", () => {
      // Save and clear explicit overrides so we test the XDG/default fallback paths
      const saved = {
        data: Bun.env.OPENPALM_DATA_HOME,
        config: Bun.env.OPENPALM_CONFIG_HOME,
        state: Bun.env.OPENPALM_STATE_HOME,
      };
      try {
        delete Bun.env.OPENPALM_DATA_HOME;
        delete Bun.env.OPENPALM_CONFIG_HOME;
        delete Bun.env.OPENPALM_STATE_HOME;
        const paths = resolveXDGPaths();
        expect(paths.data).toMatch(/openpalm$/);
        expect(paths.config).toMatch(/openpalm$/);
        expect(paths.state).toMatch(/openpalm$/);
      } finally {
        if (saved.data !== undefined) Bun.env.OPENPALM_DATA_HOME = saved.data; else delete Bun.env.OPENPALM_DATA_HOME;
        if (saved.config !== undefined) Bun.env.OPENPALM_CONFIG_HOME = saved.config; else delete Bun.env.OPENPALM_CONFIG_HOME;
        if (saved.state !== undefined) Bun.env.OPENPALM_STATE_HOME = saved.state; else delete Bun.env.OPENPALM_STATE_HOME;
      }
    });
  });

  describe("createDirectoryTree", () => {
    it("creates all expected subdirectories", async () => {
      // Create a temporary directory
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));

      try {
        const xdg = {
          data: join(tempDir, "data"),
          config: join(tempDir, "config"),
          state: join(tempDir, "state"),
        };

        await createDirectoryTree(xdg);

        // Verify data subdirectories
        const dataDirs = ["postgres", "qdrant", "openmemory", "assistant", "admin"];
        for (const dir of dataDirs) {
          const dirPath = join(xdg.data, dir);
          const stats = await stat(dirPath);
          expect(stats.isDirectory()).toBe(true);
        }

        // Verify config root directory exists
        const configStats = await stat(xdg.config);
        expect(configStats.isDirectory()).toBe(true);

        // Verify state subdirectories
        const stateDirs = ["admin", "gateway", "postgres", "qdrant", "openmemory", "openmemory-ui", "assistant", "rendered", "rendered/caddy", "rendered/caddy/snippets", "automations", "caddy/config", "caddy/data", "logs", "tmp"];
        for (const dir of stateDirs) {
          const dirPath = join(xdg.state, dir);
          const stats = await stat(dirPath);
          expect(stats.isDirectory()).toBe(true);
        }
      } finally {
        // Clean up
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("resolveXDGPaths with OPENPALM env overrides", () => {
    it("uses OPENPALM_*_HOME env vars when set", () => {
      // Save original values
      const originalData = Bun.env.OPENPALM_DATA_HOME;
      const originalConfig = Bun.env.OPENPALM_CONFIG_HOME;
      const originalState = Bun.env.OPENPALM_STATE_HOME;

      try {
        // Set custom paths
        Bun.env.OPENPALM_DATA_HOME = "/tmp/test-data";
        Bun.env.OPENPALM_CONFIG_HOME = "/tmp/test-config";
        Bun.env.OPENPALM_STATE_HOME = "/tmp/test-state";

        const paths = resolveXDGPaths();
        expect(paths.data).toBe("/tmp/test-data");
        expect(paths.config).toBe("/tmp/test-config");
        expect(paths.state).toBe("/tmp/test-state");
      } finally {
        // Restore original values
        if (originalData !== undefined) {
          Bun.env.OPENPALM_DATA_HOME = originalData;
        } else {
          delete Bun.env.OPENPALM_DATA_HOME;
        }
        if (originalConfig !== undefined) {
          Bun.env.OPENPALM_CONFIG_HOME = originalConfig;
        } else {
          delete Bun.env.OPENPALM_CONFIG_HOME;
        }
        if (originalState !== undefined) {
          Bun.env.OPENPALM_STATE_HOME = originalState;
        } else {
          delete Bun.env.OPENPALM_STATE_HOME;
        }
      }
    });
  });

  describe("resolveXDGPaths with XDG fallback", () => {
    it("falls back to XDG_*_HOME/openpalm when OPENPALM_*_HOME not set", () => {
      // Save original values
      const originalOPData = Bun.env.OPENPALM_DATA_HOME;
      const originalOPConfig = Bun.env.OPENPALM_CONFIG_HOME;
      const originalOPState = Bun.env.OPENPALM_STATE_HOME;
      const originalXDGData = Bun.env.XDG_DATA_HOME;
      const originalXDGConfig = Bun.env.XDG_CONFIG_HOME;
      const originalXDGState = Bun.env.XDG_STATE_HOME;

      try {
        // Delete OPENPALM_*_HOME env vars
        delete Bun.env.OPENPALM_DATA_HOME;
        delete Bun.env.OPENPALM_CONFIG_HOME;
        delete Bun.env.OPENPALM_STATE_HOME;

        // Set XDG_*_HOME env vars
        Bun.env.XDG_DATA_HOME = "/tmp/xdg-data";
        Bun.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
        Bun.env.XDG_STATE_HOME = "/tmp/xdg-state";

        const paths = resolveXDGPaths();
        expect(paths.data).toBe("/tmp/xdg-data/openpalm");
        expect(paths.config).toBe("/tmp/xdg-config/openpalm");
        expect(paths.state).toBe("/tmp/xdg-state/openpalm");
      } finally {
        // Restore original values
        if (originalOPData !== undefined) {
          Bun.env.OPENPALM_DATA_HOME = originalOPData;
        } else {
          delete Bun.env.OPENPALM_DATA_HOME;
        }
        if (originalOPConfig !== undefined) {
          Bun.env.OPENPALM_CONFIG_HOME = originalOPConfig;
        } else {
          delete Bun.env.OPENPALM_CONFIG_HOME;
        }
        if (originalOPState !== undefined) {
          Bun.env.OPENPALM_STATE_HOME = originalOPState;
        } else {
          delete Bun.env.OPENPALM_STATE_HOME;
        }
        if (originalXDGData !== undefined) {
          Bun.env.XDG_DATA_HOME = originalXDGData;
        } else {
          delete Bun.env.XDG_DATA_HOME;
        }
        if (originalXDGConfig !== undefined) {
          Bun.env.XDG_CONFIG_HOME = originalXDGConfig;
        } else {
          delete Bun.env.XDG_CONFIG_HOME;
        }
        if (originalXDGState !== undefined) {
          Bun.env.XDG_STATE_HOME = originalXDGState;
        } else {
          delete Bun.env.XDG_STATE_HOME;
        }
      }
    });
  });
});
