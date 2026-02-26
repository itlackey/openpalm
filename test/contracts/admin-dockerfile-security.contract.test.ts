import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("admin dockerfile security contract", () => {
  it("installs docker CLI client tooling without embedding a docker daemon", () => {
    const dockerfile = readFileSync("core/admin/Dockerfile", "utf8");

    expect(dockerfile.includes("docker-ce-cli")).toBe(true);
    expect(dockerfile.includes("dockerd")).toBe(false);
    expect(dockerfile.includes("docker-ce ")).toBe(false);
  });

  it("defines a non-root runtime user for app install/build steps", () => {
    const dockerfile = readFileSync("core/admin/Dockerfile", "utf8");
    expect(dockerfile.includes("USER openpalm")).toBe(true);
  });
});
