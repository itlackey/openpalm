import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

type PackageJson = {
  devDependencies?: Record<string, string>;
};

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

describe("playwright version contract", () => {
  it("keeps @playwright/test aligned between admin and ui workspaces", () => {
    const admin = readPackageJson("core/admin/package.json");
    const ui = readPackageJson("packages/ui/package.json");

    expect(admin.devDependencies?.["@playwright/test"]).toBeDefined();
    expect(ui.devDependencies?.["@playwright/test"]).toBeDefined();
    expect(admin.devDependencies?.["@playwright/test"]).toBe(ui.devDependencies?.["@playwright/test"]);
  });
});
