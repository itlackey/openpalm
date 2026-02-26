import { describe, expect, it } from "bun:test";
import { resolveInContainerSocketPath } from "./runtime.ts";

describe("resolveInContainerSocketPath", () => {
  it("returns docker socket path for docker", () => {
    expect(resolveInContainerSocketPath("docker")).toBe("/var/run/docker.sock");
  });

  it("returns docker socket path for podman", () => {
    expect(resolveInContainerSocketPath("podman")).toBe("/var/run/docker.sock");
  });
});
