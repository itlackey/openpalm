import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setVersion, SEMVER_RE } from "./set-version.mjs";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "op-setver-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(pkg: unknown): string {
  const f = join(dir, "package.json");
  writeFileSync(f, `${JSON.stringify(pkg, null, 2)}\n`);
  return f;
}
type Pkg = {
  version: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};
function read(f: string): Pkg {
  // Normalize missing maps to {} so the return value actually matches Pkg at
  // runtime (a package.json may omit dependencies/peerDependencies); keeps the
  // type sound for tests that read those keys.
  const raw = JSON.parse(readFileSync(f, "utf-8")) as Pkg;
  return { dependencies: {}, peerDependencies: {}, ...raw };
}

describe("set-version", () => {
  it("stamps the version field", () => {
    const f = write({ name: "x", version: "0.0.0" });
    setVersion(f, "1.2.3");
    expect(read(f).version).toBe("1.2.3");
  });

  it("accepts prerelease semver", () => {
    const f = write({ name: "x", version: "0.0.0" });
    setVersion(f, "0.11.0-rc.18");
    expect(read(f).version).toBe("0.11.0-rc.18");
  });

  it("rejects non-semver", () => {
    const f = write({ name: "x", version: "0.0.0" });
    expect(() => setVersion(f, "v1.2")).toThrow();
    expect(() => setVersion(f, "latest")).toThrow();
  });

  it("rewrites a >= @openpalm/lib floor range in lockstep (deps + peerDeps)", () => {
    const f = write({
      name: "x",
      version: "0.10.0",
      dependencies: { "@openpalm/lib": ">=0.10.0 <1.0.0", other: "^1.0.0" },
      peerDependencies: { "@openpalm/lib": ">=0.10.0 <1.0.0" },
    });
    setVersion(f, "0.11.0");
    const pkg = read(f);
    expect(pkg.dependencies["@openpalm/lib"]).toBe(">=0.11.0 <1.0.0");
    expect(pkg.peerDependencies["@openpalm/lib"]).toBe(">=0.11.0 <1.0.0");
    expect(pkg.dependencies.other).toBe("^1.0.0"); // untouched
  });

  it("leaves workspace: and exact @openpalm/lib refs untouched", () => {
    const f = write({
      name: "x",
      version: "0.10.0",
      dependencies: { "@openpalm/lib": "workspace:*" },
    });
    setVersion(f, "0.11.0");
    expect(read(f).dependencies["@openpalm/lib"]).toBe("workspace:*");
  });

  it("computes the major-bound ceiling from the new major", () => {
    const f = write({
      name: "x",
      version: "1.0.0",
      dependencies: { "@openpalm/lib": ">=1.0.0 <2.0.0" },
    });
    setVersion(f, "2.3.4");
    expect(read(f).dependencies["@openpalm/lib"]).toBe(">=2.3.4 <3.0.0");
  });

  it("SEMVER_RE matches stable + prerelease, rejects junk", () => {
    expect(SEMVER_RE.test("0.11.0")).toBe(true);
    expect(SEMVER_RE.test("0.11.0-rc.17")).toBe(true);
    expect(SEMVER_RE.test("0.11")).toBe(false);
  });
});
