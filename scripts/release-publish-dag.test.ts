// P5e (#555) — STATIC/CONFIG tests for the release publish DAG
// (ui-runtime-modes-plan.md Phase 5 item 5: "@openpalm/client joins the
// publish DAG and the exact-pin table"; §8.10 / simplicity guardrails:
// @openpalm/ui-kit is a raw-source workspace package and is NEVER published).
//
// The publish DAG lives in .github/workflows/release.yml (the plan's
// "platform-release.yml" — there is no separate file; unit=platform/all of
// release.yml is the platform release). These tests parse the workflow YAML
// (Bun.YAML) and assert structure, not runtime behavior.
//
// Red/green map (test-first):
//   - "release workflow YAML is well-formed"            -> GREEN (characterization)
//   - "@openpalm/client joins the publish DAG"          -> RED until P5e item 1 lands
//   - "@openpalm/ui-kit stays unpublished"              -> GREEN (characterization — must stay)
//   - "client purity gate wired into CI"                -> RED until P5e item 3 lands
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const RELEASE_WORKFLOW = join(WORKFLOWS_DIR, "release.yml");
const CI_WORKFLOW = join(WORKFLOWS_DIR, "ci.yml");
const PUBLISH_REUSABLE = "publish-npm-package.yml";

type Step = { name?: string; run?: string; with?: Record<string, unknown> };
type Job = {
	uses?: string;
	needs?: string | string[];
	if?: string;
	with?: Record<string, unknown>;
	steps?: Step[];
};

function parseWorkflow(path: string): Record<string, unknown> {
	return Bun.YAML.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function jobsOf(workflow: Record<string, unknown>): Record<string, Job> {
	return (workflow.jobs ?? {}) as Record<string, Job>;
}

function needsList(job: Job): string[] {
	if (Array.isArray(job.needs)) return job.needs;
	return job.needs ? [job.needs] : [];
}

/** All jobs (across one workflow) that call the reusable npm publish workflow. */
function publishJobs(workflow: Record<string, unknown>): Array<[string, Job]> {
	return Object.entries(jobsOf(workflow)).filter(
		([, job]) => typeof job.uses === "string" && job.uses.includes(PUBLISH_REUSABLE),
	);
}

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter(
	(f) => f.endsWith(".yml") || f.endsWith(".yaml"),
);

describe("P5e — release workflow YAML is well-formed (characterization — green)", () => {
	test("every workflow under .github/workflows parses as YAML", () => {
		for (const file of workflowFiles) {
			expect(() => parseWorkflow(join(WORKFLOWS_DIR, file))).not.toThrow();
		}
	});

	test("release.yml is the publish DAG and publishes @openpalm/ui (the artifact client mirrors)", () => {
		const release = parseWorkflow(RELEASE_WORKFLOW);
		const names = publishJobs(release).map(([, job]) => job.with?.["package-name"]);
		expect(names).toContain("@openpalm/ui");
	});
});

describe("P5e — @openpalm/client joins the publish DAG (RED until P5e item 1)", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);
	const clientEntry = publishJobs(release).find(
		([, job]) => job.with?.["package-name"] === "@openpalm/client",
	);

	test("a job publishes @openpalm/client via the reusable publish-npm-package.yml", () => {
		expect(clientEntry).toBeDefined();
	});

	test("client publish mirrors @openpalm/ui: package-dir, exact-version pin, needs-build, computed version", () => {
		const w = clientEntry?.[1].with ?? {};
		expect(w["package-dir"]).toBe("packages/client");
		// Exact-pin delivery (plan §6.9/§6.11): the assistant container installs
		// @openpalm/client@<platform version>, so the publish must be exact-version.
		expect(w["exact-version"]).toBe(true);
		// The client is a built static bundle (adapter-static), like @openpalm/ui.
		expect(w["needs-build"]).toBe(true);
		expect(String(w.version ?? "")).toContain("compute-version.outputs.new_version");
	});

	test("client publish is gated on the same units as @openpalm/ui (platform | all)", () => {
		const cond = String(clientEntry?.[1].if ?? "");
		expect(cond).toContain("inputs.unit == 'platform'");
		expect(cond).toContain("inputs.unit == 'all'");
	});

	test("client publish depends on compute-version + bump (publishes the stamped ref)", () => {
		const needs = needsList(clientEntry?.[1] ?? {});
		expect(needs).toContain("compute-version");
		expect(needs).toContain("bump");
	});

	test("tag-release (TAG-LAST invariant) waits on the client publish job", () => {
		// "tag exists = fully published" — a failed client publish must block the tag.
		const clientJobId = clientEntry?.[0] ?? "<missing @openpalm/client publish job>";
		expect(needsList(jobs["tag-release"] ?? {})).toContain(clientJobId);
	});

	test("the npm regression guard covers @openpalm/client for platform + all units", () => {
		const guard = (jobs["compute-version"]?.steps ?? []).find((s) =>
			s.run?.includes("npmPackages"),
		);
		expect(guard).toBeDefined();
		expect(guard?.run ?? "").toContain("'@openpalm/client'");
	});

	test("the explicit-version stamp path stamps packages/client/package.json", () => {
		// Mirrors packages/ui/package.json in the bump job's VERSION_OVERRIDE case
		// list — otherwise an override release ships a client whose version does
		// not match the platform pin the assistant container installs.
		const stamp = (jobs.bump?.steps ?? []).find((s) => s.run?.includes("set-version.mjs"));
		expect(stamp).toBeDefined();
		expect(stamp?.run ?? "").toContain("packages/client/package.json");
	});
});

describe("P5e — @openpalm/ui-kit stays unpublished (characterization — green, must stay)", () => {
	test("no workflow passes @openpalm/ui-kit (or packages/ui-kit) to publish-npm-package.yml", () => {
		for (const file of workflowFiles) {
			const workflow = parseWorkflow(join(WORKFLOWS_DIR, file));
			for (const [id, job] of publishJobs(workflow)) {
				expect(`${file}:${id}:${String(job.with?.["package-name"])}`).not.toContain(
					"@openpalm/ui-kit",
				);
				expect(`${file}:${id}:${String(job.with?.["package-dir"])}`).not.toContain(
					"packages/ui-kit",
				);
			}
		}
	});

	test("publish-npm-package.yml's own input defaults do not point at ui-kit", () => {
		const raw = readFileSync(join(WORKFLOWS_DIR, PUBLISH_REUSABLE), "utf-8");
		expect(raw).not.toContain("@openpalm/ui-kit");
		expect(raw).not.toContain("packages/ui-kit");
	});
});

describe("P5e — client-bundle purity gate wired into CI (RED until P5e item 3)", () => {
	test("the purity test itself exists (P5b — characterization)", () => {
		expect(existsSync(join(ROOT, "packages/client/tests/purity.test.ts"))).toBe(true);
	});

	test("ci.yml has a job that builds the client and then runs the client tests (purity gate)", () => {
		// The P5b purity test greps the BUILT bundle under packages/client/build/
		// and deliberately FAILS when the build dir is absent — so CI must build
		// the client before any invocation that runs packages/client tests.
		const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
			scripts?: Record<string, string>;
		};
		const rootTestRunsClient = /packages\/client\b/.test(rootPkg.scripts?.test ?? "");

		const buildsClient = (run: string) =>
			/client:build|--cwd packages\/client[^\n]*\bbuild\b|cd packages\/client[^\n]*\bbuild\b/.test(
				run,
			);
		const runsClientTests = (run: string) =>
			/client:test|bun test[^\n]*packages\/client|--cwd packages\/client[^\n]*\btest\b/.test(
				run,
			) ||
			(rootTestRunsClient && /\bbun run test\b/.test(run));

		const ci = parseWorkflow(CI_WORKFLOW);
		const gated = Object.values(jobsOf(ci)).some((job) => {
			const runs = (job.steps ?? []).map((s) => s.run ?? "");
			const buildIdx = runs.findIndex(buildsClient);
			if (buildIdx < 0) return false;
			return runs.slice(buildIdx + 1).some(runsClientTests);
		});
		expect(gated).toBe(true);
	});
});

// ── C1 (2026-07-10 review): @openpalm/portal-sdk was never added to the
// publish DAG. The live 0.13.0-beta.1 discord/slack portal packages pin
// @openpalm/portal-sdk@0.12.52 exact (baked in by `bun pm pack` resolving the
// workspace:* dependency at pack time) — but portal-sdk was never published,
// so the adapters are uninstallable (E404). Fix: add an npm-portal-sdk job
// mirroring the other npm-* jobs, needs-ed by both portal adapters + tag-release.
describe("C1 — @openpalm/portal-sdk joins the publish DAG (RED until C1 fix)", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);
	const portalSdkEntry = publishJobs(release).find(
		([, job]) => job.with?.["package-name"] === "@openpalm/portal-sdk",
	);

	test("a job publishes @openpalm/portal-sdk via the reusable publish-npm-package.yml", () => {
		expect(portalSdkEntry).toBeDefined();
	});

	test("portal-sdk publish mirrors the discord/slack portal jobs: package-dir, exact-version pin, computed version", () => {
		const w = portalSdkEntry?.[1].with ?? {};
		expect(w["package-dir"]).toBe("packages/portal-sdk");
		expect(w["exact-version"]).toBe(true);
		expect(String(w.version ?? "")).toContain("compute-version.outputs.new_version");
	});

	test("portal-sdk publish is gated on the same units as the discord/slack portals (portals | all)", () => {
		const cond = String(portalSdkEntry?.[1].if ?? "");
		expect(cond).toContain("inputs.unit == 'portals'");
		expect(cond).toContain("inputs.unit == 'all'");
	});

	test("portal-sdk publish depends on compute-version + bump", () => {
		const needs = needsList(portalSdkEntry?.[1] ?? {});
		expect(needs).toContain("compute-version");
		expect(needs).toContain("bump");
	});

	test("both discord-portal and slack-portal publish jobs need npm-portal-sdk (sdk before adapters)", () => {
		const portalSdkJobId = portalSdkEntry?.[0] ?? "<missing @openpalm/portal-sdk publish job>";
		const discordEntry = publishJobs(release).find(
			([, job]) => job.with?.["package-name"] === "@openpalm/discord-portal",
		);
		const slackEntry = publishJobs(release).find(
			([, job]) => job.with?.["package-name"] === "@openpalm/slack-portal",
		);
		expect(needsList(discordEntry?.[1] ?? {})).toContain(portalSdkJobId);
		expect(needsList(slackEntry?.[1] ?? {})).toContain(portalSdkJobId);
	});

	test("tag-release (TAG-LAST invariant) waits on the portal-sdk publish job", () => {
		const portalSdkJobId = portalSdkEntry?.[0] ?? "<missing @openpalm/portal-sdk publish job>";
		expect(needsList(jobs["tag-release"] ?? {})).toContain(portalSdkJobId);
	});
});

// The generic DAG-completeness invariant the review calls out as "THE KEY
// REGRESSION TEST": every RUNTIME (dependencies, not devDependencies)
// workspace:* dependency of a published package must itself be published in
// the same DAG. devDependencies workspace:* refs (e.g. @openpalm/ui-kit into
// @openpalm/ui / @openpalm/client) are build-time-only and get inlined by the
// consuming app's bundler — they are NOT baked into the tarball as a runtime
// dependency by `bun pm pack`, unlike a `dependencies` entry, which bun
// resolves to the workspace package's on-disk version at pack time. This is
// exactly the shape of the C1 bug: portals/{discord,slack}/package.json list
// @openpalm/portal-sdk under `dependencies` as workspace:*.
describe("C1 — every workspace:* runtime dependency of a published package is a published DAG node", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const nodes = publishJobs(release);
	const publishedNames = new Set(nodes.map(([, job]) => String(job.with?.["package-name"])));

	for (const [id, job] of nodes) {
		const packageDir = job.with?.["package-dir"];
		if (typeof packageDir !== "string") continue;
		const manifestPath = join(ROOT, packageDir, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
			dependencies?: Record<string, string>;
		};
		const workspaceRuntimeDeps = Object.entries(manifest.dependencies ?? {}).filter(
			([, range]) => range === "workspace:*",
		);
		for (const [depName] of workspaceRuntimeDeps) {
			test(`${id} (${String(job.with?.["package-name"])}) declares runtime workspace:* dep ${depName}, which must be a published node`, () => {
				expect(publishedNames.has(depName)).toBe(true);
			});
		}
	}
});

// ── I1 (2026-07-10 review): docker-assistant needs only [compute-version,
// bump] — no ordering after npm-client/npm-skeleton, and nothing stops it
// baking a PLATFORM_VERSION that has no published @openpalm/client or
// @openpalm/skeleton (a `unit=assistant` release anchors on the completely
// independent containers/assistant/VERSION file, NOT the platform npm
// version). Fix: unit-tolerant needs on npm-client/npm-skeleton + a preflight
// step resolving/validating PLATFORM_VERSION before the image build.
describe("I1 — docker-assistant is ordered after npm-client/npm-skeleton and preflights PLATFORM_VERSION", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);
	const assistantJob = jobs["docker-assistant"];

	test("docker-assistant needs npm-client and npm-skeleton", () => {
		const needs = needsList(assistantJob ?? {});
		expect(needs).toContain("npm-client");
		expect(needs).toContain("npm-skeleton");
	});

	test("docker-assistant's if is unit-tolerant of npm-client/npm-skeleton being skipped (standalone unit=assistant runs)", () => {
		// Matches the house pattern used by docker-guardian: `!= 'failure'` (not
		// `== 'success'`), because npm-client/npm-skeleton are only requested for
		// unit=platform/all and are legitimately 'skipped' for unit=assistant/images.
		const cond = String(assistantJob?.if ?? "");
		expect(cond).toContain("needs.npm-client.result != 'failure'");
		expect(cond).toContain("needs.npm-skeleton.result != 'failure'");
	});

	test("docker-assistant preflights that the baked client/skeleton version is actually published on npm", () => {
		const steps = assistantJob?.steps ?? [];
		const preflight = steps.find((s) => /npm view/.test(s.run ?? ""));
		expect(preflight).toBeDefined();
		expect(preflight?.run ?? "").toContain("@openpalm/client");
		expect(preflight?.run ?? "").toContain("@openpalm/skeleton");
		// Must actually fail the build on a 404, not just warn.
		expect(preflight?.run ?? "").toMatch(/exit 1|::error::/);
	});

	test("docker-assistant does not blindly bake compute-version's unit-local anchor as PLATFORM_VERSION for image-only units", () => {
		// unit=assistant's compute-version output is bumped from
		// containers/assistant/VERSION — an anchor independent of the platform npm
		// version. The build-arg must come from a step that resolves the actual
		// last-published platform version for that unit, not
		// needs.compute-version.outputs.new_version directly.
		const steps = assistantJob?.steps ?? [];
		const buildStep = steps.find((s) => s.name === "Build and push");
		const buildArgs = String(buildStep?.with?.["build-args"] ?? "");
		expect(buildArgs).not.toContain("needs.compute-version.outputs.new_version");
		expect(buildArgs).toMatch(/PLATFORM_VERSION=\$\{\{\s*steps\.\w+\.outputs\.\w+\s*\}\}/);
	});
});

describe("guardian image dry-run stays buildable before npm publish", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);
	const guardianJob = jobs["docker-guardian"];

	test("dry-run stamps local guardian and skeleton sources before the image build", () => {
		const stampStep = (guardianJob?.steps ?? []).find((s) =>
			s.name?.includes("Stamp local guardian/skeleton sources for dry-run image build"),
		);
		expect(stampStep).toBeDefined();
		expect(stampStep?.run ?? "").toContain("packages/guardian/package.json");
		expect(stampStep?.run ?? "").toContain("packages/skeleton/package.json");
	});

	test("guardian image build switches to local source packages in dry-run mode", () => {
		const buildStep = (guardianJob?.steps ?? []).find((s) => s.name === "Build and push");
		expect(buildStep).toBeDefined();
		expect(String(buildStep?.with?.["build-args"] ?? buildStep?.run ?? "")).toContain(
			"GUARDIAN_USE_LOCAL_SOURCE",
		);
		expect(String(buildStep?.with?.["build-args"] ?? buildStep?.run ?? "")).toContain(
			"SKELETON_USE_LOCAL_SOURCE",
		);
	});
});
