import { describe, expect, it, mock } from "bun:test";
import { composeExec } from "@openpalm/lib/compose.ts";
import type { ComposeConfig, SpawnFn } from "@openpalm/lib/types.ts";

describe("compose", () => {
  describe("composeExec", () => {
    const config: ComposeConfig = {
      bin: "docker",
      subcommand: "compose",
      envFile: "/path/to/.env",
      composeFile: "/path/to/docker-compose.yml",
    };

    it("passes env-file and compose file args", async () => {
      let capturedArgs: string[] = [];
      const spawnMock = mock((args: string[]) => {
        capturedArgs = args;
        return {
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
        };
      }) as unknown as SpawnFn;

      await composeExec(config, ["ps"], { spawn: spawnMock });

      expect(capturedArgs).toContain("--env-file");
      expect(capturedArgs).toContain("/path/to/.env");
      expect(capturedArgs).toContain("-f");
      expect(capturedArgs).toContain("/path/to/docker-compose.yml");
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
      }) as unknown as SpawnFn;

      const result = await composeExec(config, ["ps"], { timeout: 1, spawn: spawnMock });
      expect(result.code).toBe("timeout");
      expect(result.exitCode).toBe(1);
    });
  });
});
