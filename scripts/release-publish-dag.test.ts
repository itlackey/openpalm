// P5e (#555) — STATIC/CONFIG tests for the release publish DAG
// (simplicity guardrails: @openpalm/ui-kit is a raw-source workspace package
// and is NEVER published).
//
// The publish DAG lives in .github/workflows/release.yml (the plan's
// "platform-release.yml" — there is no separate file; unit=platform/all of
// release.yml is the platform release). These tests parse the workflow YAML
// (Bun.YAML) and assert structure, not runtime behavior.
//
// Red/green map (test-first):
//   - "release workflow YAML is well-formed"            -> GREEN (characterization)
//   - "@openpalm/ui-kit stays unpublished"              -> GREEN (characterization — must stay)
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const RELEASE_WORKFLOW = join(WORKFLOWS_DIR, "release.yml");
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

	test("release.yml is the publish DAG and publishes @openpalm/ui", () => {
		const release = parseWorkflow(RELEASE_WORKFLOW);
		const names = publishJobs(release).map(([, job]) => job.with?.["package-name"]);
		expect(names).toContain("@openpalm/ui");
	});
});

describe("P5e — release DAG stamps via the canonical unit stamper", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);

	test("explicit-version stamping delegates to the canonical unit stamper", () => {
		// A hand-maintained VERSION_OVERRIDE case list drifted from bump-unit.mjs
		// and published beta.4 adapters pinned to portal-sdk beta.3. Every release
		// path must use the same unit definitions.
		const stamp = (jobs.bump?.steps ?? []).find((s) => s.name === "Stamp unit files");
		expect(stamp).toBeDefined();
		expect(stamp?.run ?? "").toContain("node scripts/bump-unit.mjs");
		expect(stamp?.run ?? "").not.toContain("set-version.mjs");
		expect(readFileSync(join(ROOT, "scripts/bump-unit.mjs"), "utf-8")).toContain(
			"VERSION_OVERRIDE",
		);
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
// @openpalm/ui) are build-time-only and get inlined by the
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
// bump] — no ordering after npm-skeleton, and nothing stops it baking a
// PLATFORM_VERSION that has no published @openpalm/skeleton (a `unit=assistant`
// release anchors on the completely independent containers/assistant/VERSION
// file, NOT the platform npm version). Fix: unit-tolerant needs on npm-skeleton
// + a preflight step resolving/validating PLATFORM_VERSION before the image build.
describe("I1 — docker-assistant is ordered after npm-skeleton and preflights PLATFORM_VERSION", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);
	const assistantJob = jobs["docker-assistant"];

	test("docker-assistant needs npm-skeleton", () => {
		const needs = needsList(assistantJob ?? {});
		expect(needs).toContain("npm-skeleton");
	});

	test("docker-assistant's if is unit-tolerant of npm-skeleton being skipped (standalone unit=assistant runs)", () => {
		// Matches the house pattern used by docker-guardian: `!= 'failure'` (not
		// `== 'success'`), because npm-skeleton is only requested for
		// unit=platform/all and is legitimately 'skipped' for unit=assistant/images.
		const cond = String(assistantJob?.if ?? "");
		expect(cond).toContain("needs.npm-skeleton.result != 'failure'");
	});

	test("docker-assistant preflights that the baked skeleton version is actually published on npm", () => {
		const steps = assistantJob?.steps ?? [];
		const preflight = steps.find((s) => /npm view/.test(s.run ?? ""));
		expect(preflight).toBeDefined();
		expect(preflight?.run ?? "").toContain("@openpalm/skeleton");
		// Must actually fail the build on a 404, not just warn.
		expect(preflight?.run ?? "").toMatch(/exit 1|::error::/);
	});

	// F13 (2026-07-10 review, dry-run guard follow-up): the preflight has no
	// `if: !inputs.dry_run` guard, unlike every "Guard — fail if image tag
	// already exists" step — the docker-portal, docker-guardian, and
	// docker-assistant jobs each carry one. dry_run=true is the default and
	// documented "always run first"
	// mode — npm-skeleton packs-and-validates but deliberately SKIPS
	// the actual publish on dry-run, so the freshly-bumped PLATFORM_VERSION is
	// never on npm and `npm view` 404s, failing docker-assistant on every
	// dry-run of unit=all/images/platform(+images). Fix: guard the preflight
	// step with the same `if: !inputs.dry_run` the image-tag guards use.
	test("F13 — the npm-published-version preflight is skipped in dry-run (matches the image-tag guard steps)", () => {
		const steps = assistantJob?.steps ?? [];
		const preflight = steps.find((s) => /npm view/.test(s.run ?? ""));
		expect(preflight).toBeDefined();
		expect(String(preflight?.if ?? "")).toContain("!inputs.dry_run");
	});

	// F13 follow-up (2026-07-11 review): guarding the preflight above is not
	// enough on its own — the same unpublished freshly-bumped platform_version
	// is still passed as a literal --build-arg to BOTH the smoke build and the
	// real "Build and push" step, which are NOT guarded by dry_run (the smoke
	// step has no `if:` at all; "Build and push" always builds, only `push` is
	// gated). The assistant entrypoint hard-fails via
	// `npm install ... "@openpalm/skeleton@${PLATFORM_VERSION}"` (no fallback)
	// whenever PLATFORM_VERSION is non-empty, so a dry-run of unit=all/images/
	// platform(+images) still fails at docker-assistant — one step later, as an
	// opaque npm E404 from inside the docker build instead of the preflight's
	// explicit ::error::. Fix: gate the build-arg itself so dry-run bakes an
	// empty PLATFORM_VERSION, which the Dockerfile already treats as a no-op
	// ("Skipped when PLATFORM_VERSION is unset").
	test("F13 — the assistant image smoke build does not bake a live PLATFORM_VERSION on dry-run", () => {
		const steps = assistantJob?.steps ?? [];
		const smoke = steps.find((s) => s.name === "Assistant image smoke (amd64 only)");
		expect(smoke).toBeDefined();
		// IMG-6 built this step on buildx (sharing the push step's gha cache so
		// the release builds the image once, not twice), so the build-arg moved
		// from an inline `--build-arg` into `with.build-args` — same guard.
		const buildArgs = String(smoke?.with?.["build-args"] ?? "");
		expect(buildArgs).toMatch(
			/PLATFORM_VERSION=\$\{\{\s*!inputs\.dry_run\s*&&\s*steps\.\w+\.outputs\.\w+\s*\|\|\s*''\s*\}\}/,
		);
		// The smoke must never push — it only gates the push step below it.
		expect(smoke?.with?.push).toBe(false);
		expect(smoke?.with?.load).toBe(true);
	});

	test("F13 — the Build and push step does not bake a live PLATFORM_VERSION on dry-run", () => {
		const steps = assistantJob?.steps ?? [];
		const buildStep = steps.find((s) => s.name === "Build and push");
		const buildArgs = String(buildStep?.with?.["build-args"] ?? "");
		expect(buildArgs).toMatch(
			/PLATFORM_VERSION=\$\{\{\s*!inputs\.dry_run\s*&&\s*steps\.\w+\.outputs\.\w+\s*\|\|\s*''\s*\}\}/,
		);
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
		expect(buildArgs).toMatch(/PLATFORM_VERSION=\$\{\{[\s\S]*?steps\.\w+\.outputs\.\w+[\s\S]*?\}\}/);
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
