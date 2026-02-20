import { describe, expect, it } from "bun:test";
import { buildComposeArgs } from "../src/lib/compose.ts";
import type { ComposeConfig } from "../src/types.ts";

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
});
