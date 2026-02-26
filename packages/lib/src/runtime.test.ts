import { describe, expect, it } from "bun:test";
import { resolveSocketPath } from "./runtime.ts";

describe("resolveSocketPath", () => {
  it("returns docker socket path for linux", () => {
    expect(resolveSocketPath("linux")).toBe("/var/run/docker.sock");
  });

  it("returns named pipe for windows", () => {
    expect(resolveSocketPath("windows")).toBe("//./pipe/docker_engine");
  });
});
