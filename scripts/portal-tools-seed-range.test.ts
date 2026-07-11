// C1 (2026-07-10 review) — the operator-managed portal-tools seed
// (packages/skeleton/data/portal/tools/package.json) pins the discord/slack
// portal adapters with a `^0.12.0` caret range. Caret ranges on a 0.x version
// only float the PATCH digit (^0.12.0 == >=0.12.0 <0.13.0 per semver), so an
// existing OP_HOME install's seed silently never picks up a 0.13.x+ adapter
// release. bump-unit.mjs must advance that range's floor whenever the portals
// unit is stamped — this test exercises the regex-replace directly (against a
// scratch copy, never the real seed file) and pins that it is wired into the
// portals unit's stamp().
//
// Red/green map (test-first):
//   - "stampPortalToolsSeedRanges rewrites both adapter ranges" -> would not
//     exist before C1 (RED: ReferenceError/undefined import)
//   - "wired into UNITS.portals.stamp"                          -> RED until C1 fix
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampPortalToolsSeedRanges, PORTAL_TOOLS_SEED_FILE } from "./bump-unit.mjs";

const ROOT = join(import.meta.dir, "..");

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "op-portal-seed-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("C1 — stampPortalToolsSeedRanges advances the seed's caret ranges", () => {
	test("rewrites both discord-portal and slack-portal ranges to ^<version>, preserving everything else", () => {
		const f = join(dir, "package.json");
		const original = readFileSync(join(ROOT, PORTAL_TOOLS_SEED_FILE), "utf-8");
		writeFileSync(f, original);

		stampPortalToolsSeedRanges("0.13.5", f);

		const updated = JSON.parse(readFileSync(f, "utf-8")) as {
			name?: string;
			private?: boolean;
			dependencies?: Record<string, string>;
		};
		expect(updated.dependencies?.["@openpalm/discord-portal"]).toBe("^0.13.5");
		expect(updated.dependencies?.["@openpalm/slack-portal"]).toBe("^0.13.5");
		// Unrelated fields untouched.
		expect(updated.name).toBe("@openpalm/portal-tools");
		expect(updated.private).toBe(true);
	});

	test("caret range floor genuinely advances a semver minor (the bug this fixes)", () => {
		// ^0.12.0 satisfies 0.12.x only; ^0.13.5 satisfies 0.13.x only. Advancing
		// the floor at release time is what makes new adapter releases reachable
		// at all for an existing OP_HOME install's `bun install`.
		const f = join(dir, "package.json");
		writeFileSync(
			f,
			JSON.stringify(
				{
					name: "@openpalm/portal-tools",
					private: true,
					dependencies: {
						"@openpalm/discord-portal": "^0.12.0",
						"@openpalm/slack-portal": "^0.12.0",
					},
				},
				null,
				2,
			),
		);
		stampPortalToolsSeedRanges("0.13.0", f);
		const updated = JSON.parse(readFileSync(f, "utf-8")) as { dependencies: Record<string, string> };
		expect(updated.dependencies["@openpalm/discord-portal"]).not.toContain("0.12");
		expect(updated.dependencies["@openpalm/discord-portal"]).toContain("0.13.0");
	});

	test("throws on a missing file (mirrors stampJsonFiles/stampVersionFile's fail-loud contract)", () => {
		expect(() => stampPortalToolsSeedRanges("0.13.5", join(dir, "does-not-exist.json"))).toThrow();
	});
});

describe("C1 — the seed range advance is wired into the portals unit's stamp", () => {
	test("scripts/bump-unit.mjs calls stampPortalToolsSeedRanges(...) inside UNITS.portals.stamp", () => {
		const src = readFileSync(join(ROOT, "scripts/bump-unit.mjs"), "utf-8");
		const portalsBlockMatch = src.match(/portals:\s*\{[\s\S]*?\n {2}\},/);
		expect(portalsBlockMatch).not.toBeNull();
		expect(portalsBlockMatch?.[0] ?? "").toContain("stampPortalToolsSeedRanges(");
	});

	test("scripts/bump-unit.mjs also stamps packages/portal-sdk/package.json inside UNITS.portals.stamp", () => {
		const src = readFileSync(join(ROOT, "scripts/bump-unit.mjs"), "utf-8");
		const portalsBlockMatch = src.match(/portals:\s*\{[\s\S]*?\n {2}\},/);
		expect(portalsBlockMatch?.[0] ?? "").toContain("packages/portal-sdk/package.json");
	});
});
