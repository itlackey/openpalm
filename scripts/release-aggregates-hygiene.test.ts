// P5e (#555) — STATIC/CONFIG repo-hygiene tests for release integration.
//
// Asserts the ROOT package.json check/test aggregates reference the shared UI
// package (packages/ui-kit), that packages/ui-kit stays a private raw-source
// package, and that the ui-kit manifest is a member of the platform
// stamp/version-sync sets.
//
// Red/green map (test-first):
//   - check aggregate covers ui + ui-kit                 -> GREEN (characterization)
//   - test aggregate runs packages/ui-kit               -> GREEN (characterization)
//   - ui-kit manifest stays private                     -> GREEN (characterization — must stay)
//   - platform stamp/version-sync membership            -> GREEN
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Manifest = {
	name?: string;
	version?: string;
	private?: boolean;
	publishConfig?: { access?: string };
	files?: string[];
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
};

function readJson(relPath: string): Manifest {
	return JSON.parse(readFileSync(join(ROOT, relPath), "utf-8")) as Manifest;
}

const rootPkg = readJson("package.json");
const rootScripts = rootPkg.scripts ?? {};

describe("P5e — root check aggregate covers the UI packages (characterization — green)", () => {
	test("`bun run check` includes ui:check + ui-kit:check", () => {
		const check = rootScripts.check ?? "";
		expect(check).toContain("ui:check");
		expect(check).toContain("ui-kit:check");
	});
});

describe("P5e — root test aggregate runs the shared UI package test dir", () => {
	test("`bun run test` runs packages/ui-kit (characterization — green)", () => {
		expect(rootScripts.test ?? "").toContain("packages/ui-kit");
	});
});

describe("P5e — packages/ui-kit stays a private raw-source package (characterization — green, must stay)", () => {
	const uiKit = readJson("packages/ui-kit/package.json");

	test("private: true (never published — plan simplicity guardrails)", () => {
		expect(uiKit.private).toBe(true);
	});

	test("declares no publishConfig", () => {
		expect(uiKit.publishConfig).toBeUndefined();
	});
});

describe("C4 — packages/ui-kit belongs to a release unit (RED until C4 fix)", () => {
	// d8b3fe04 "stamp all to 0.13.0-beta.1" missed packages/ui-kit — it belongs
	// to no release unit, so it silently drifted to 0.12.52 and CI's per-unit
	// version-sync check (ci.yml "Validate per-unit version sync") can't catch
	// it because ui-kit isn't a member of any unit's manifest list. Not
	// load-bearing today (private, workspace:* raw source, never published —
	// see the P5e "ui-kit stays unpublished" tests above, which this fix does
	// NOT change), but it misleads debugging and any future publish decision.
	test(".github/release-package-groups.json platform unit lists packages/ui-kit/package.json", () => {
		const groups = JSON.parse(
			readFileSync(join(ROOT, ".github/release-package-groups.json"), "utf-8"),
		) as { units: Record<string, string[]> };
		expect(groups.units.platform).toContain("packages/ui-kit/package.json");
	});

	test("scripts/bump-unit.mjs stamps packages/ui-kit/package.json with the platform unit", () => {
		const bumpUnit = readFileSync(join(ROOT, "scripts/bump-unit.mjs"), "utf-8");
		expect(bumpUnit).toContain("RELEASE_PACKAGE_GROUPS.platform");
	});

	test("packages/ui-kit stays private (this fix wires the unit membership only — it does not publish ui-kit)", () => {
		const uiKit = readJson("packages/ui-kit/package.json");
		expect(uiKit.private).toBe(true);
	});
});

describe("release package ownership is disjoint", () => {
  const groups = JSON.parse(
    readFileSync(join(ROOT, ".github/release-package-groups.json"), "utf-8"),
  ) as { units: Record<string, string[]> };

  test("each manifest has exactly one canonical owner", () => {
    const manifests = Object.values(groups.units).flat();
    expect(new Set(manifests).size).toBe(manifests.length);
  });

  test("guardian and electron have independent owner groups", () => {
    expect(groups.units.guardian).toEqual(["packages/guardian/package.json"]);
    expect(groups.units.electron).toEqual([
      "packages/electron/package.json",
      "packages/electron/admin-tools/package.json",
    ]);
    expect(groups.units.platform).toContain("packages/skeleton/package.json");
  });
});

describe("portal image pins match the portal release unit", () => {
  test("baked Discord and Slack versions equal their source manifests", () => {
    const tools = readJson("containers/portal/tools/package.json");
    expect(tools.dependencies?.["@openpalm/discord-portal"]).toBe(
      readJson("portals/discord/package.json").version,
    );
    expect(tools.dependencies?.["@openpalm/slack-portal"]).toBe(
      readJson("portals/slack/package.json").version,
    );
  });
});
