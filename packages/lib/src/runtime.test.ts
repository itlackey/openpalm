import { describe, expect, it } from "bun:test";
import { resolveSocketPath } from "./runtime.ts";

describe("resolveSocketPath", () => {
  it("returns docker socket path for linux", () => {
    expect(resolveSocketPath("docker", "linux")).toBe("/var/run/docker.sock");
  });

  it("returns named pipe for windows", () => {
    expect(resolveSocketPath("docker", "windows")).toBe("//./pipe/docker_engine");
  });
});
