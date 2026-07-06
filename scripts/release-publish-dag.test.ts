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

type Step = { name?: string; run?: string };
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
