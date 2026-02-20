import { describe, expect, it } from "bun:test";
import { resolveXDGPaths, createDirectoryTree } from "../src/lib/paths.ts";
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

    it("all paths end with openpalm", () => {
      const paths = resolveXDGPaths();
      expect(paths.data).toMatch(/openpalm$/);
      expect(paths.config).toMatch(/openpalm$/);
      expect(paths.state).toMatch(/openpalm$/);
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
        const dataDirs = ["postgres", "qdrant", "openmemory", "shared", "caddy", "admin"];
        for (const dir of dataDirs) {
          const dirPath = join(xdg.data, dir);
          const stats = await stat(dirPath);
          expect(stats.isDirectory()).toBe(true);
        }

        // Verify config subdirectories
        const configDirs = ["opencode-core", "caddy", "channels", "cron"];
        for (const dir of configDirs) {
          const dirPath = join(xdg.config, dir);
          const stats = await stat(dirPath);
          expect(stats.isDirectory()).toBe(true);
        }

        // Verify state subdirectories
        const stateDirs = ["opencode-core", "gateway", "caddy", "workspace", "observability", "backups"];
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
});
