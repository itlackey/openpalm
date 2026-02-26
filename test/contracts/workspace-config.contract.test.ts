import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

type RootPackageJson = {
  workspaces?: string[];
};

type UiPackageJson = {
  name?: string;
};

type TsConfig = {
  include?: string[];
  exclude?: string[];
};

describe("workspace configuration contract", () => {
  it("uses scoped UI package name", () => {
    const ui = JSON.parse(readFileSync("packages/ui/package.json", "utf8")) as UiPackageJson;
    expect(ui.name).toBe("@openpalm/ui");
  });

  it("keeps root tsconfig from contradictory UI include/exclude entries", () => {
    const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as TsConfig;
    const include = tsconfig.include ?? [];
    const exclude = tsconfig.exclude ?? [];

    expect(include.includes("packages/ui/src/**/*.ts")).toBe(false);
    expect(exclude.includes("packages/ui")).toBe(true);
  });

  it("does not list empty assistant container directory as workspace member", () => {
    const root = JSON.parse(readFileSync("package.json", "utf8")) as RootPackageJson;
    const workspaces = root.workspaces ?? [];
    expect(workspaces.includes("core/assistant")).toBe(false);
  });
});
