import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSemver, parseSemver, setVersion, SEMVER_RE } from "./set-version.mjs";

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
  devDependencies: Record<string, string>;
};
function read(f: string): Pkg {
  // Normalize missing maps to {} so the return value actually matches Pkg at
  // runtime (a package.json may omit dependency maps); keeps the
  // type sound for tests that read those keys.
  const raw = JSON.parse(readFileSync(f, "utf-8")) as Pkg;
  return { dependencies: {}, peerDependencies: {}, devDependencies: {}, ...raw };
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

  it("leaves dependency references untouched", () => {
    const f = write({
      name: "x",
      version: "0.10.0",
      dependencies: { "@openpalm/lib": ">=0.10.0 <1.0.0", other: "^1.0.0" },
      peerDependencies: { "@openpalm/lib": ">=0.10.0 <1.0.0" },
    });
    setVersion(f, "0.11.0");
    const pkg = read(f);
    expect(pkg.dependencies["@openpalm/lib"]).toBe(">=0.10.0 <1.0.0");
    expect(pkg.peerDependencies["@openpalm/lib"]).toBe(">=0.10.0 <1.0.0");
    expect(pkg.dependencies.other).toBe("^1.0.0");
  });

  it("SEMVER_RE matches stable + prerelease, rejects junk", () => {
    expect(SEMVER_RE.test("0.11.0")).toBe(true);
    expect(SEMVER_RE.test("0.11.0-rc.17")).toBe(true);
    expect(SEMVER_RE.test("0.11")).toBe(false);
  });

  it("rejects shell-bearing and non-canonical release targets", () => {
    for (const version of [
      "1.2.3-$(id)",
      "1.2.3-`id`",
      "1.2.3-foo/bar",
      "1.2.3-foo..bar",
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-01",
    ]) {
      expect(parseSemver(version)).toBeNull();
    }
  });

  // The release workflow's monotonicity guard rejects a dispatch strictly
  // lower than the highest published version and allows equal re-runs, so
  // these orderings are load-bearing for the 'latest' pointers.
  it("compareSemver orders release tuples, prereleases, and identifiers per semver §11", () => {
    expect(compareSemver("0.13.0", "0.13.0")).toBe(0);
    expect(compareSemver("0.12.9", "0.13.0")).toBe(-1);
    expect(compareSemver("0.14.0", "0.13.0")).toBe(1);
    // A prerelease sorts BEFORE its release...
    expect(compareSemver("0.13.0-beta.24", "0.13.0")).toBe(-1);
    // ...but a prerelease of the NEXT version sorts after the current release.
    expect(compareSemver("0.14.0-beta.1", "0.13.0")).toBe(1);
    // Numeric identifiers compare numerically (beta.4 < beta.10).
    expect(compareSemver("0.13.0-beta.10", "0.13.0-beta.4")).toBe(1);
    // A longer identifier set wins over its own prefix.
    expect(compareSemver("0.13.0-beta.1.1", "0.13.0-beta.1")).toBe(1);
    // Non-numeric identifiers compare lexically (rc > beta).
    expect(compareSemver("0.13.0-rc.1", "0.13.0-beta.9")).toBe(1);
    expect(() => compareSemver("nope", "0.13.0")).toThrow();
  });
});
