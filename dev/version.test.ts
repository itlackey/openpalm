import { describe, expect, it } from "bun:test";
import { COMPONENTS, bumpSemver, readCurrentVersions } from "./version.ts";

describe("version manager", () => {
  it("reads platform and component versions from package manifests", () => {
    const versions = readCurrentVersions();
    expect(versions.platform).toMatch(/^\d+\.\d+\.\d+$/);
    for (const name of Object.keys(COMPONENTS)) {
      expect(versions.components[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("bumps semver versions", () => {
    expect(bumpSemver("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpSemver("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpSemver("1.2.3", "major")).toBe("2.0.0");
  });
});
