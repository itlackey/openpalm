// C2 (2026-07-10 review) — the packaged Electron app ships no client
// artifact. packages/electron/electron-builder.yml's extraResources lists
// only ui-build/admin-tools/skeleton, but packages/lib/src/control-plane/
// client-assets.ts's `resolveLocalClientBuild` strategy 2 probes
// `resourcesPath/client-build` for a bundled client, and main.ts resolves the
// serve script at `join(buildDir, '..', 'bin', 'serve.mjs')` — i.e.
// `resourcesPath/bin/serve.mjs`, a SIBLING of client-build. Neither directory
// is packaged, so every desktop install permanently runs the host-UI
// fallback with no indication. electron-builder.yml is DATA (no code), so
// this is a static YAML "pin" test, alongside the release.yml wiring that
// actually builds packages/client and needs-es npm-client before packaging.
//
// Red/green map (test-first):
//   - extraResources contains client-build + bin entries -> RED until C2 fix
//   - release.yml electron job builds the client + needs npm-client -> RED until C2 fix
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ELECTRON_BUILDER_YML = join(ROOT, "packages", "electron", "electron-builder.yml");
const RELEASE_WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");

type ExtraResource = { from?: string; to?: string; filter?: string };
type BuilderConfig = { extraResources?: ExtraResource[] };

function parseBuilderConfig(): BuilderConfig {
	return Bun.YAML.parse(readFileSync(ELECTRON_BUILDER_YML, "utf-8")) as BuilderConfig;
}

type Step = { name?: string; run?: string; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; if?: string; steps?: Step[] };

function needsList(job: Job): string[] {
	if (Array.isArray(job.needs)) return job.needs;
	return job.needs ? [job.needs] : [];
}

describe("C2 — electron-builder.yml packages the @openpalm/client artifact", () => {
	const config = parseBuilderConfig();
	const resources = config.extraResources ?? [];

	test("extraResources bundles packages/client/build as client-build (client-assets.ts strategy 2: resourcesPath/client-build)", () => {
		const entry = resources.find((r) => r.from === "../../packages/client/build");
		expect(entry).toBeDefined();
		expect(entry?.to).toBe("client-build");
	});

	test("extraResources bundles packages/client/bin as bin (main.ts: join(buildDir, '..', 'bin', 'serve.mjs') => resourcesPath/bin/serve.mjs)", () => {
		const entry = resources.find((r) => r.from === "../../packages/client/bin");
		expect(entry).toBeDefined();
		expect(entry?.to).toBe("bin");
	});

	test("the existing ui-build/admin-tools/skeleton extraResources entries are untouched", () => {
		expect(resources.some((r) => r.from === "../../packages/ui/build" && r.to === "ui-build")).toBe(true);
		expect(resources.some((r) => r.to === "admin-tools/index.js")).toBe(true);
		expect(resources.some((r) => r.from === "../../packages/skeleton" && r.to === "openpalm-skeleton")).toBe(true);
	});
});

describe("C2 — release.yml builds the client and orders the electron job after npm-client", () => {
	function parseWorkflow(): Record<string, unknown> {
		return Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, "utf-8")) as Record<string, unknown>;
	}
	const release = parseWorkflow();
	const jobs = (release.jobs ?? {}) as Record<string, Job>;
	const electronJob = jobs.electron;

	test("electron job needs npm-client", () => {
		expect(needsList(electronJob ?? {})).toContain("npm-client");
	});

	test("electron job's if is unit-tolerant of npm-client (electron unit bypasses npm entirely; platform/all require success)", () => {
		const cond = String(electronJob?.if ?? "");
		expect(cond).toContain("needs.npm-client.result == 'success'");
	});

	test("electron job builds the client (bun run client:build) before bundling the Electron app", () => {
		const steps = electronJob?.steps ?? [];
		const buildClientIdx = steps.findIndex((s) => /client:build|--cwd packages\/client[^\n]*\bbuild\b/.test(s.run ?? ""));
		const bundleIdx = steps.findIndex((s) => s.name === "Bundle Electron app");
		expect(buildClientIdx).toBeGreaterThanOrEqual(0);
		expect(bundleIdx).toBeGreaterThanOrEqual(0);
		expect(buildClientIdx).toBeLessThan(bundleIdx);
	});
});
