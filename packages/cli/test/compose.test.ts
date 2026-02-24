import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { buildComposeArgs, composeExec } from "@openpalm/lib/compose.ts";
import type { ComposeConfig } from "@openpalm/lib/types.ts";

describe("compose", () => {
  describe("buildComposeArgs", () => {
    it("returns correct array structure", () => {
      const config: ComposeConfig = {
        bin: "docker",
        subcommand: "compose",
        envFile: "/path/to/.env",
        composeFile: "/path/to/docker-compose.yml",
      };

      const args = buildComposeArgs(config);

      expect(Array.isArray(args)).toBe(true);
      expect(args).toHaveLength(5);
    });

    it("includes subcommand, --env-file, -f flags in correct order", () => {
      const config: ComposeConfig = {
        bin: "docker",
        subcommand: "compose",
        envFile: "/path/to/.env",
        composeFile: "/path/to/docker-compose.yml",
      };

      const args = buildComposeArgs(config);

      expect(args[0]).toBe("compose");
      expect(args[1]).toBe("--env-file");
      expect(args[2]).toBe("/path/to/.env");
      expect(args[3]).toBe("-f");
      expect(args[4]).toBe("/path/to/docker-compose.yml");
    });
  });

  describe("composeExec", () => {
    const config: ComposeConfig = {
      bin: "docker",
      subcommand: "compose",
      envFile: "/path/to/.env",
      composeFile: "/path/to/docker-compose.yml",
    };

    let originalSpawn: typeof Bun.spawn;

    beforeEach(() => {
      originalSpawn = Bun.spawn;
    });

    afterEach(() => {
      Bun.spawn = originalSpawn;
      mock.restore();
    });

    it("passes env-file and compose file args", async () => {
      const spawnMock = mock(() => ({
        exited: Promise.resolve(0),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      }));
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn;

      await composeExec(config, ["ps"]);

      const call = (spawnMock.mock.calls as unknown as Array<unknown[]>)[0];
      const args = (call ? call[0] : []) as string[];
      expect(args).toContain("--env-file");
      expect(args).toContain("/path/to/.env");
      expect(args).toContain("-f");
      expect(args).toContain("/path/to/docker-compose.yml");
    });

    it("returns timeout error code when aborted", async () => {
      const spawnMock = mock((_args: string[], options?: { signal?: AbortSignal }) => {
        let onAbort: (() => void) | null = null;
        const exited = new Promise<number>((resolve, reject) => {
          onAbort = () => reject(new Error("timeout"));
          if (options?.signal) {
            if (options.signal.aborted) return reject(new Error("timeout"));
            options.signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        return {
          exited,
          exitCode: 1,
          stdout: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          stderr: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        };
      });
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn;

      const result = await composeExec(config, ["ps"], { timeout: 1 });
      expect(result.code).toBe("timeout");
      expect(result.exitCode).toBe(1);
    });
  });
});
