// P5e (#555) — STATIC/CONFIG repo-hygiene tests for release integration
// (ui-runtime-modes-plan.md Phase 5 items 5-6, §8 invariants).
//
// Asserts the ROOT package.json check/test aggregates reference the two new
// UI packages (packages/client, packages/ui-kit), that packages/client is
// npm-publishable the same way @openpalm/ui is (exact-pin delivered), that
// packages/ui-kit stays a private raw-source package, and that the client
// manifest is a member of the platform stamp/version-sync sets.
//
// Red/green map (test-first):
//   - check aggregate + client workspace scripts        -> GREEN (characterization — wired in P5b)
//   - test aggregate runs packages/ui-kit               -> GREEN (characterization)
//   - test aggregate runs packages/client               -> RED until P5e item 2
//   - client manifest publishable like @openpalm/ui     -> RED until P5e item 1
//   - ui-kit manifest stays private                     -> GREEN (characterization — must stay)
//   - platform stamp/version-sync membership            -> RED until P5e item 1
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
};

function readJson(relPath: string): Manifest {
	return JSON.parse(readFileSync(join(ROOT, relPath), "utf-8")) as Manifest;
}

const rootPkg = readJson("package.json");
const rootScripts = rootPkg.scripts ?? {};

describe("P5e — root check aggregate covers the new packages (characterization — green)", () => {
	test("`bun run check` includes ui:check + ui-kit:check + client:check", () => {
		const check = rootScripts.check ?? "";
		expect(check).toContain("ui:check");
		expect(check).toContain("ui-kit:check");
		expect(check).toContain("client:check");
	});

	test("client workspace scripts exist at the root and point at packages/client", () => {
		expect(rootScripts["client:check"] ?? "").toContain("packages/client");
		expect(rootScripts["client:build"] ?? "").toContain("packages/client");
		expect(rootScripts["client:test"] ?? "").toContain("packages/client");
	});
});

describe("P5e — root test aggregate runs the new packages' test dirs", () => {
	test("`bun run test` runs packages/ui-kit (characterization — green)", () => {
		expect(rootScripts.test ?? "").toContain("packages/ui-kit");
	});

	test("`bun run test` runs packages/client (RED until P5e item 2)", () => {
		// Either the dir joins the `bun test` path list directly, or the aggregate
		// chains the client:test workspace script — both satisfy the gate.
		expect(rootScripts.test ?? "").toMatch(/packages\/client\b|client:test/);
	});
});

describe("P5e — packages/client manifest is publishable like @openpalm/ui (RED until P5e item 1)", () => {
	const client = readJson("packages/client/package.json");

	test("named @openpalm/client and NOT private (npm refuses to publish private packages)", () => {
		expect(client.name).toBe("@openpalm/client");
		expect(client.private).not.toBe(true);
	});

	test("scoped package declares publishConfig.access public (mirrors @openpalm/ui)", () => {
		expect(client.publishConfig?.access).toBe("public");
	});

	test("ships the built bundle via files: ['build', ...]", () => {
		expect(client.files ?? []).toContain("build");
	});

	test("version stays in lockstep with the root platform version (exact-pin table)", () => {
		// The assistant container installs @openpalm/client@$OP_CLIENT_VERSION
		// with PLATFORM_VERSION as the fallback (P5d) — the client MUST be
		// stamped at the platform version, exactly like @openpalm/ui.
		expect(client.version).toBe(rootPkg.version);
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

describe("P5e — platform stamp/version-sync membership for packages/client (RED until P5e item 1)", () => {
	test(".github/release-package-groups.json platform unit lists packages/client/package.json", () => {
		// CI's "Validate per-unit version sync" step reads this file; membership
		// is what enforces client == root version on every PR.
		const groups = JSON.parse(
			readFileSync(join(ROOT, ".github/release-package-groups.json"), "utf-8"),
		) as { units: Record<string, string[]> };
		expect(groups.units.platform).toContain("packages/client/package.json");
	});

	test("scripts/bump-unit.mjs stamps packages/client/package.json with the platform unit", () => {
		// Mirrors packages/ui/package.json in the platform stamp list so a normal
		// (non-override) release bumps the client with the rest of the unit.
		const bumpUnit = readFileSync(join(ROOT, "scripts/bump-unit.mjs"), "utf-8");
		expect(bumpUnit).toContain("packages/client/package.json");
	});
});
