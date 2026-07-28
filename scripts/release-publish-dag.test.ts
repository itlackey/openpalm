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
import {
	expectedImages,
	expectedReleaseJobs,
	verifyReleaseImages,
	verifyReleaseJobs,
} from "./verify-release-images.mjs";

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const RELEASE_WORKFLOW = join(WORKFLOWS_DIR, "release.yml");
const VOICE_WORKFLOW = join(WORKFLOWS_DIR, "publish-voice.yml");
const ASSISTANT_MODELS_WORKFLOW = join(WORKFLOWS_DIR, "publish-assistant-models.yml");
const VOICE_MODELS_WORKFLOW = join(WORKFLOWS_DIR, "publish-voice-models.yml");
const VOICE_DOCKERFILE = join(ROOT, "containers", "voice", "Dockerfile");
const VOICE_ENTRYPOINT = join(ROOT, "containers", "voice", "entrypoint.sh");
const VOICE_TTS = join(ROOT, "containers", "voice", "app", "tts.py");
const COMPOSE_DEV = join(ROOT, "compose.dev.yml");
const ROOTLESS_SMOKE_FIXTURE = join(ROOT, "scripts", "rootless-smoke-fixture.sh");
const PUBLISH_REUSABLE = "publish-npm-package.yml";
const PUBLISH_WORKFLOW = join(WORKFLOWS_DIR, PUBLISH_REUSABLE);

type Step = {
	name?: string;
	run?: string;
	uses?: string;
	if?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};
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

describe("release target inputs are validated before credentialed jobs", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);

	test("release.yml validates the computed target with the shared strict parser", () => {
		const step = (jobs["compute-version"]?.steps ?? []).find(
			(s) => s.name === "Validate target version and resolve metadata",
		);
		expect(step).toBeDefined();
		expect(step?.run ?? "").toContain("parseSemver");
		expect(step?.env?.VERSION ?? "").toContain("steps.bump.outputs.new_version");
		expect(step?.run ?? "").not.toContain("${{");
	});

	test("Docker guards receive validated refs through env and fail closed on lookup errors", () => {
		for (const id of ["docker-portal", "docker-guardian", "docker-assistant"]) {
			const guard = (jobs[id]?.steps ?? []).find(
				(s) => s.name === "Guard — fail if image tag already exists",
			);
			expect(guard).toBeDefined();
			expect(String(guard?.env?.IMAGE_REF ?? "")).toContain(
				"compute-version.outputs.new_version",
			);
			expect(guard?.run ?? "").not.toContain("${{");
			expect(guard?.run ?? "").toContain("manifest unknown|no such manifest");
			expect(guard?.run ?? "").toContain("Could not verify Docker target");
		}
	});

	test("shared registry publication is globally serialized", () => {
		const concurrency = release.concurrency as { group?: string } | undefined;
		expect(concurrency?.group).toBe("release");
	});

	test("target versions are never interpolated directly into shell scripts", () => {
		for (const path of [RELEASE_WORKFLOW, VOICE_WORKFLOW]) {
			const workflow = parseWorkflow(path);
			for (const [jobId, job] of Object.entries(jobsOf(workflow))) {
				for (const step of job.steps ?? []) {
					const run = step.run ?? "";
					expect(`${jobId}:${step.name ?? "unnamed"}:${run}`).not.toMatch(
						/\$\{\{\s*(?:inputs\.version|needs\.compute-version\.outputs\.new_version|steps\.platform_version\.outputs\.platform_version)/,
					);
				}
			}
		}
	});
});

describe("Voice release validation and Dockerfile guard", () => {
	const voice = parseWorkflow(VOICE_WORKFLOW);
	const jobs = jobsOf(voice);

	test("Voice validates the version in a prerequisite job before Docker login", () => {
		const validate = jobs["validate-version"];
		const push = jobs["push-voice-images"];
		expect((validate?.steps ?? []).some((step) => (step.run ?? "").includes("parseSemver"))).toBe(
			true,
		);
		expect(needsList(push ?? {})).toContain("validate-version");
		const guard = (push?.steps ?? []).find((step) => step.name === "Guard immutable image tag");
		expect(guard?.run ?? "").not.toContain("${{");
		expect(guard?.env?.VERSION ?? "").toContain("inputs.version");
		const promote = (jobs["promote-latest"]?.steps ?? []).find(
			(step) => step.name === "Promote signed immutable variants",
		);
		expect(promote?.run ?? "").not.toContain("${{");
		expect(promote?.run ?? "").toContain("openpalm/voice@${digest}");
		expect(String(jobs["promote-latest"]?.if ?? "")).toContain("prerelease == 'false'");
	});

	test("Voice releases are globally serialized", () => {
		const concurrency = voice.concurrency as { group?: string } | undefined;
		expect(concurrency?.group).toBe("publish-voice");
	});

	test("Voice validates monotonic variant tags before Docker login", () => {
		const validate = jobs["validate-version"];
		const runs = (validate?.steps ?? []).map((step) => step.run ?? "").join("\n");
		expect(runs).toContain("assert-docker-tag-monotonic.mjs");
		expect(runs).toContain("cpu cu121");
		const pushSteps = jobs["push-voice-images"]?.steps ?? [];
		expect(pushSteps.findIndex((step) => step.name === "Login to Docker Hub")).toBeGreaterThan(
			-1,
		);
	});

	test("continued Dockerfile command lines retain a trailing backslash", () => {
		const lines = readFileSync(VOICE_DOCKERFILE, "utf-8").split("\n");
		for (let index = 1; index < lines.length; index++) {
			if (!lines[index]?.trimStart().startsWith("&&")) continue;
			expect(lines[index - 1]?.trimEnd().endsWith("\\")).toBe(true);
		}
	});

	test("Voice CUDA replaces the resolver-installed CPU ONNX runtime", () => {
		const dockerfile = readFileSync(VOICE_DOCKERFILE, "utf-8");
		const requirementsInstall = dockerfile.indexOf("pip install -r /build/requirements.txt");
		const cpuUninstall = dockerfile.indexOf("pip uninstall -y onnxruntime");
		const gpuInstall = dockerfile.indexOf('pip install --no-deps "onnxruntime-gpu==1.20.1"');
		expect(requirementsInstall).toBeGreaterThan(-1);
		expect(cpuUninstall).toBeGreaterThan(requirementsInstall);
		expect(gpuInstall).toBeGreaterThan(cpuUninstall);
		expect(dockerfile).toContain("CUDAExecutionProvider");
	});

	test("Voice CUDA explicitly selects the GPU provider for Kokoro", () => {
		const entrypoint = readFileSync(VOICE_ENTRYPOINT, "utf-8");
		expect(entrypoint).toContain("site-packages/nvidia/*/lib");
		expect(entrypoint).toContain(
			'export ONNX_PROVIDER="${ONNX_PROVIDER:-CUDAExecutionProvider}"',
		);
		const tts = readFileSync(VOICE_TTS, "utf-8");
		expect(tts).toContain("engine.sess.get_providers()");
		expect(tts).toContain("expected_provider not in providers");
	});
});

describe("release source is one tested candidate commit", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);

	test("candidate preparation bundles the stamped commit without pushing it", () => {
		const runs = (jobs.bump?.steps ?? []).map((step) => step.run ?? "").join("\n");
		expect(runs).toContain("node scripts/bump-unit.mjs");
		expect(runs).toContain("bun install --lockfile-only");
		expect(runs).toContain("git bundle create");
		expect(runs).not.toContain("git push");
	});

	test("preflight restores the prepared candidate before testing", () => {
		expect(needsList(jobs.preflight ?? {})).toContain("bump");
		const runs = (jobs.preflight?.steps ?? []).map((step) => step.run ?? "").join("\n");
		expect(runs).toContain("restore-release-candidate.sh");
	});

	test("the live source gate waits for preflight and uses a base lease without rebasing", () => {
		const source = jobs["release-source"];
		expect(needsList(source ?? {})).toContain("preflight");
		const runs = (source?.steps ?? []).map((step) => step.run ?? "").join("\n");
		expect(runs).toContain("--force-with-lease");
		expect(runs).not.toContain("pull --rebase");
	});

	test("every orchestrated npm publish receives the candidate bundle coordinates", () => {
		for (const [, job] of publishJobs(release)) {
			expect(needsList(job)).toContain("release-source");
			expect(String(job.with?.["base-sha"] ?? "")).toContain("release-source.outputs.base_sha");
			expect(String(job.with?.["candidate-sha"] ?? "")).toContain(
				"release-source.outputs.candidate_sha",
			);
			expect(String(job.with?.["source-artifact"] ?? "")).toContain(
				"release-source.outputs.source_artifact",
			);
		}
	});

	test("every artifact and release job restores the tested candidate", () => {
		for (const id of [
			"docker-portal",
			"docker-guardian",
			"docker-assistant",
			"cli",
			"electron",
			"tag-release",
		]) {
			const job = jobs[id];
			expect(needsList(job ?? {})).toContain("release-source");
			const runs = (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
			expect(runs).toContain("restore-release-candidate.sh");
		}
	});
});

describe("release publishing preserves candidate identity and fails loudly", () => {
	test("npm provenance is bound to the verified candidate HEAD", () => {
		const publish = readFileSync(PUBLISH_WORKFLOW, "utf-8");
		expect(publish).toContain('HEAD_SHA=$(git rev-parse HEAD)');
		expect(publish).toContain('GITHUB_SHA="${HEAD_SHA}" npm publish');
		expect(publish).toContain("ref: ${{ inputs.base-sha }}");
		expect(publish).not.toContain("workflow_dispatch:");
		expect(publish).not.toContain("Commit version bump");
	});

	test("GitHub release retries keep an existing release and do not suppress creation failures", () => {
		const release = readFileSync(RELEASE_WORKFLOW, "utf-8");
		expect(release).not.toContain("gh release delete");
		expect(release).toContain('gh release upload "${TAG}" dist/* --clobber');
		expect(release).not.toMatch(/gh release create[\s\S]*?\|\| true/);
	});

	test("stable Docker latest tags are promoted only in the final release job", () => {
		const release = parseWorkflow(RELEASE_WORKFLOW);
		const jobs = jobsOf(release);
		for (const id of ["docker-portal", "docker-guardian", "docker-assistant"]) {
			const metadata = (jobs[id]?.steps ?? []).find((step) => step.name === "Docker metadata");
			expect(String(metadata?.with?.tags ?? "")).not.toContain("latest");
		}
		const tagSteps = jobs["tag-release"]?.steps ?? [];
		const promoteIndex = tagSteps.findIndex((step) => step.name === "Promote stable Docker tags");
		const tagIndex = tagSteps.findIndex((step) => step.name === "Create + push tags");
		expect(promoteIndex).toBeGreaterThanOrEqual(0);
		expect(promoteIndex).toBeLessThan(tagIndex);
		expect(tagSteps[promoteIndex]?.run ?? "").toContain("imagetools create");
		expect(tagSteps[promoteIndex]?.run ?? "").toContain("openpalm/${image}@${digest}");
		expect(tagSteps[promoteIndex]?.run ?? "").not.toContain("openpalm/${image}:${VERSION}");
	});

	test("every selected image is checked against Docker tag history before source publication", () => {
		const release = parseWorkflow(RELEASE_WORKFLOW);
		const jobs = jobsOf(release);
		const compute = jobs["compute-version"];
		const runs = (compute?.steps ?? []).map((step) => step.run ?? "").join("\n");
		expect(runs).toContain("assert-docker-tag-monotonic.mjs");
		expect(runs).toContain('IMAGE="openpalm/${image}"');
	});

	test("prefixed GitHub releases are explicitly excluded from GitHub Latest", () => {
		const release = parseWorkflow(RELEASE_WORKFLOW);
		const jobs = jobsOf(release);
		const create = (jobs["tag-release"]?.steps ?? []).find(
			(step) => step.name === "Create GitHub releases",
		);
		const run = create?.run ?? "";
		expect(run).toContain("LATEST_ARGS=(--latest=false)");
		expect(run).toContain('create_release "${PREFIX}-${VERSION}" "OpenPalm ${PREFIX} ${VERSION}" false');
		expect(run).toContain('create_release "${UNIT}-${VERSION}" "OpenPalm ${UNIT} ${VERSION}" false');
		expect(run).toContain('create_release "${VERSION}" "OpenPalm ${VERSION} (all units)" true');
	});
});

describe("model bundle workflows publish immutable signed tags before latest", () => {
	for (const [name, path] of [
		["assistant", ASSISTANT_MODELS_WORKFLOW],
		["voice", VOICE_MODELS_WORKFLOW],
	] as const) {
		test(`${name} model bundle is monotonic, signed, and digest-promoted`, () => {
			const workflow = parseWorkflow(path);
			const job = jobsOf(workflow)["build-models"];
			const steps = job?.steps ?? [];
			const validateIndex = steps.findIndex((step) => step.name === "Validate monotonic immutable model tag");
			const loginIndex = steps.findIndex((step) => step.name === "Login to Docker Hub");
			expect(validateIndex).toBeGreaterThanOrEqual(0);
			expect(validateIndex).toBeLessThan(loginIndex);
			expect(steps[validateIndex]?.run ?? "").toContain("assert-docker-tag-monotonic.mjs");
			const metadata = steps.find((step) => step.name === "Docker metadata");
			expect(String(metadata?.with?.tags ?? "")).not.toContain("value=latest");
			expect(steps.some((step) => step.name?.startsWith("Sign image"))).toBe(true);
			expect(steps.some((step) => step.name?.startsWith("Verify image signature"))).toBe(true);
			const promote = steps.find((step) => step.name === "Promote verified model bundle");
			expect(promote?.run ?? "").toContain("@${DIGEST}");
		});
	}
});

describe("release package owners are disjoint in the publish DAG", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);

	test("platform owns skeleton while guardian owns only guardian", () => {
		const skeletonCondition = String(jobs["npm-skeleton"]?.if ?? "");
		const guardianCondition = String(jobs["npm-guardian"]?.if ?? "");
		expect(skeletonCondition).toContain("inputs.unit == 'platform'");
		expect(skeletonCondition).not.toContain("inputs.unit == 'guardian'");
		expect(guardianCondition).toContain("inputs.unit == 'guardian'");
		expect(guardianCondition).not.toContain("inputs.unit == 'platform'");
	});

	test("Guardian images receive independent Guardian and skeleton versions", () => {
		const build = (jobs["docker-guardian"]?.steps ?? []).find((step) => step.name === "Build and push");
		const args = String(build?.with?.["build-args"] ?? "");
		expect(args).toContain("GUARDIAN_VERSION=");
		expect(args).toContain("SKELETON_VERSION=");
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

	test("portal-sdk publish mirrors the discord/slack portal jobs: package-dir and computed version", () => {
		const w = portalSdkEntry?.[1].with ?? {};
		expect(w["package-dir"]).toBe("packages/portal-sdk");
		expect(String(w.version ?? "")).toContain("compute-version.outputs.new_version");
	});

	test("portal-sdk publish is gated on the same units as the discord/slack portals (portals | all)", () => {
		const cond = String(portalSdkEntry?.[1].if ?? "");
		expect(cond).toContain("inputs.unit == 'portals'");
		expect(cond).toContain("inputs.unit == 'all'");
	});

	test("standalone portal publication is gated by Portal tests", () => {
		const preflight = jobs.preflight;
		const testStep = (preflight?.steps ?? []).find((step) => step.name === "Test (portals)");
		expect(testStep).toBeDefined();
		expect(String(testStep?.if ?? "")).toContain("inputs.unit == 'portals'");
		expect(testStep?.run ?? "").toContain("packages/portal-sdk");
		expect(testStep?.run ?? "").toContain("portals/discord");
		expect(testStep?.run ?? "").toContain("portals/slack");
	});

	test("portal-sdk publish depends on compute-version + the tested source gate", () => {
		const needs = needsList(portalSdkEntry?.[1] ?? {});
		expect(needs).toContain("compute-version");
		expect(needs).toContain("release-source");
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

	test("docker-portal waits for the SDK and both adapters on coordinated portal releases", () => {
		const dockerPortal = jobs["docker-portal"];
		const needs = needsList(dockerPortal ?? {});
		for (const dependency of [
			"npm-portal-sdk",
			"npm-discord-portal",
			"npm-slack-portal",
		]) {
			expect(needs).toContain(dependency);
			expect(String(dockerPortal?.if ?? "")).toContain(
				`needs.${dependency}.result == 'success'`,
			);
		}
	});

	test("portal dry-runs install candidate tarballs instead of unpublished registry pins", () => {
		const dockerPortal = jobs["docker-portal"];
		const prepare = (dockerPortal?.steps ?? []).find(
			(step) => step.name === "Prepare portal dry-run Dockerfile",
		);
		expect(prepare?.run ?? "").toContain(".release-packages/*.tgz");
		const build = (dockerPortal?.steps ?? []).find((step) => step.name === "Build and push");
		expect(String(build?.with?.file ?? "")).toContain(".release-packages/portal.Dockerfile");
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

	test("docker-assistant allows skipped npm jobs only for standalone image units", () => {
		const cond = String(assistantJob?.if ?? "");
		expect(cond).toContain("inputs.unit == 'assistant' || inputs.unit == 'images'");
		expect(cond).toContain("needs.npm-skeleton.result == 'success'");
		expect(cond).toContain("needs.npm-ui.result == 'success'");
	});

	test("docker-assistant preflights that the baked skeleton version is actually published on npm", () => {
		const steps = assistantJob?.steps ?? [];
		const preflight = steps.find((s) => /npm view/.test(s.run ?? ""));
		expect(preflight).toBeDefined();
		expect(preflight?.run ?? "").toContain("@openpalm/skeleton");
		// Must actually fail the build on a 404, not just warn.
		expect(preflight?.run ?? "").toMatch(/exit 1|::error::/);
	});

	test("registry preflight runs for live builds and dry-run image-only units", () => {
		const steps = assistantJob?.steps ?? [];
		const preflight = steps.find((s) => /npm view/.test(s.run ?? ""));
		expect(preflight).toBeDefined();
		const condition = String(preflight?.if ?? "");
		expect(condition).toContain("!inputs.dry_run");
		expect(condition).toContain("inputs.unit == 'assistant'");
		expect(condition).toContain("inputs.unit == 'images'");
	});

	test("coordinated dry-runs bake candidate package tarballs into the smoke image", () => {
		const steps = assistantJob?.steps ?? [];
		const smoke = steps.find((s) => s.name === "Assistant image smoke (amd64 only)");
		expect(smoke).toBeDefined();
		const buildArgs = String(smoke?.with?.["build-args"] ?? "");
		expect(buildArgs).toContain("inputs.unit == 'assistant'");
		expect(buildArgs).toContain("inputs.unit == 'images'");
		expect(smoke?.with?.push).toBe(false);
		expect(smoke?.with?.load).toBe(true);

		const localBake = steps.find((s) => s.name === "Bake candidate npm packages into dry-run image");
		expect(localBake).toBeDefined();
		expect(localBake?.run ?? "").toContain("containers/assistant/Dockerfile.local-packages");
		expect(localBake?.run ?? "").toContain(".release-packages");
		const localBakeDockerfile = readFileSync(
			join(ROOT, "containers", "assistant", "Dockerfile.local-packages"),
			"utf-8",
		);
		expect(localBakeDockerfile).toContain("openpalm-ui-*.tgz");
		expect(localBakeDockerfile).toContain("openpalm-skeleton-*.tgz");
	});

	test("source smoke applies local packages without requiring their version on npm", () => {
		const composeDev = readFileSync(COMPOSE_DEV, "utf-8");
		const fixture = readFileSync(ROOTLESS_SMOKE_FIXTURE, "utf-8");
		expect(composeDev).toContain("PLATFORM_VERSION: ${PLATFORM_VERSION-latest}");
		expect(fixture).toContain('compose_platform_version=""');
		expect(fixture).toContain(
			'PLATFORM_VERSION="$compose_platform_version" docker compose',
		);
		expect(fixture.indexOf('build "${targets[@]}"')).toBeLessThan(
			fixture.indexOf('bun pm pack --destination "$package_context"'),
		);
	});

	test("the registry-backed multi-platform build is live-only", () => {
		const steps = assistantJob?.steps ?? [];
		const buildStep = steps.find((s) => s.name === "Build and push");
		expect(String(buildStep?.if ?? "")).toContain("!inputs.dry_run");
		expect(String(buildStep?.with?.["build-args"] ?? "")).toContain(
			"steps.platform_version.outputs.platform_version",
		);
	});

	test("docker-assistant does not blindly bake compute-version's unit-local anchor as PLATFORM_VERSION for image-only units", () => {
		// Assistant and images releases use image tag versions independent of the
		// platform npm version. The build-arg must come from a step that resolves
		// the actual last-published platform version for those units, not
		// needs.compute-version.outputs.new_version directly.
		const steps = assistantJob?.steps ?? [];
		const resolver = steps.find((s) => s.name === "Resolve platform version for baked skeleton (I1)");
		expect(resolver?.run ?? "").toContain("'assistant' ] || [ \"${UNIT}\" = 'images'");
		expect(resolver?.run ?? "").toContain("require('./package.json').version");
		const buildStep = steps.find((s) => s.name === "Build and push");
		const buildArgs = String(buildStep?.with?.["build-args"] ?? "");
		expect(buildArgs).not.toContain("needs.compute-version.outputs.new_version");
		expect(buildArgs).toMatch(/PLATFORM_VERSION=\$\{\{[\s\S]*?steps\.\w+\.outputs\.\w+[\s\S]*?\}\}/);
	});
});

describe("guardian image dry-run uses the committed candidate", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);
	const guardianJob = jobs["docker-guardian"];

	test("restores candidate source without an ad-hoc version patch", () => {
		const runs = (guardianJob?.steps ?? []).map((step) => step.run ?? "").join("\n");
		expect(runs).toContain("restore-release-candidate.sh");
		expect(runs).not.toContain("set-version.mjs");
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

// ── Releases shipped with NO images at all (0.12.43, 0.12.45–0.12.52) ─────────
// release.yml gated the three docker-* jobs on include_images (default FALSE)
// for unit=platform/guardian/portals, and release practice had drifted to
// unit=platform. tag-release's `!contains(needs.*.result, 'failure')` treats a
// SKIPPED job as fine, so those runs published npm packages, pushed a git tag
// and cut a GitHub release with zero images — and reported success. Run
// 28460012584 (0.12.52) is the canonical example: every npm job succeeded, all
// three docker jobs skipped, tag-release succeeded.
//
// Two-part fix, both asserted here: include_images now defaults to TRUE (fixes
// the common path), and tag-release verifies the expected images actually built
// before creating any tag (makes the silent variant impossible).
describe("images-with-every-release — include_images defaults to true", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);

	test("include_images defaults to true so unit=platform builds images without a flag", () => {
		const inputs = (
			release.on as Record<string, { inputs?: Record<string, { default?: unknown }> }>
		).workflow_dispatch?.inputs;
		expect(inputs?.include_images?.default).toBe(true);
	});
});

describe("images-with-every-release — tag-release refuses to tag without its images", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);
	const tagJob = jobs["tag-release"];
	const steps = tagJob?.steps ?? [];
	const guardIndex = steps.findIndex((s) => (s.run ?? "").includes("verify-release-images.mjs"));

	test("a guard step runs verify-release-images.mjs", () => {
		expect(guardIndex).toBeGreaterThanOrEqual(0);
	});

	test("the guard runs BEFORE any tag is created or release cut", () => {
		// Order is the whole point: a guard after `Create + push tags` would fire
		// only once the tag — the thing that means "fully published" — exists.
		const tagStepIndex = steps.findIndex((s) => s.name === "Create + push tags");
		expect(tagStepIndex).toBeGreaterThanOrEqual(0);
		expect(guardIndex).toBeLessThan(tagStepIndex);
	});

	test("the guard is a STEP, not a job-level condition (a skipped tag-release is the same silence)", () => {
		// tag-release must still RUN so the guard can fail it loudly. If the job
		// `if:` ever grew the image conditions, a missing-image release would go
		// back to being green-and-untagged rather than red.
		const cond = String(tagJob?.if ?? "");
		expect(cond).not.toContain("docker-portal.result");
		expect(cond).not.toContain("docker-guardian.result");
		expect(cond).not.toContain("docker-assistant.result");
	});

	test("the guard is handed the unit, the flag, and all three docker job results", () => {
		const env = (steps[guardIndex] as { env?: Record<string, string> } | undefined)?.env ?? {};
		const wired = Object.values(env).join("\n");
		expect(wired).toContain("inputs.unit");
		expect(wired).toContain("inputs.include_images");
		expect(wired).toContain("needs.docker-portal.result");
		expect(wired).toContain("needs.docker-guardian.result");
		expect(wired).toContain("needs.docker-assistant.result");
		expect(wired).toContain("needs.npm-skeleton.result");
		expect(wired).toContain("needs.npm-portal-sdk.result");
		expect(wired).toContain("needs.cli.result");
		expect(wired).toContain("needs.electron.result");
	});

	test("tag-release still waits on all three docker jobs (results must be observable)", () => {
		const needs = needsList(tagJob ?? {});
		expect(needs).toContain("docker-portal");
		expect(needs).toContain("docker-guardian");
		expect(needs).toContain("docker-assistant");
	});
});

describe("tag-last verifies every artifact class expected by the selected unit", () => {
	test("platform cannot tag when an npm or CLI job was skipped", () => {
		const expected = expectedReleaseJobs("platform", false);
		const results = Object.fromEntries(expected.map((job) => [job, "success"]));
		results["npm-ui"] = "skipped";
		expect(verifyReleaseJobs({ unit: "platform", includeImages: false, results }).ok).toBe(false);

		results["npm-ui"] = "success";
		results.cli = "skipped";
		expect(verifyReleaseJobs({ unit: "platform", includeImages: false, results }).ok).toBe(false);
	});

	test("electron cannot tag when its installer job was skipped", () => {
		const result = verifyReleaseJobs({
			unit: "electron",
			includeImages: true,
			results: { electron: "skipped" },
		});
		expect(result.ok).toBe(false);
		expect(result.missing.map((entry) => entry.job)).toEqual(["electron"]);
	});

	test("all requires npm, image, CLI, and Electron jobs", () => {
		const expected = expectedReleaseJobs("all", true);
		expect(expected).toContain("npm-guardian");
		expect(expected).toContain("docker-portal");
		expect(expected).toContain("cli");
		expect(expected).toContain("electron");
	});
});

// The durable form of the fix: the guard's DECISION, exercised directly across
// every unit, rather than a text match on the workflow.
describe("images-with-every-release — an image-building unit cannot tag with skipped image jobs", () => {
	const ALL_SKIPPED = { portal: "skipped", guardian: "skipped", assistant: "skipped" };
	const ALL_BUILT = { portal: "success", guardian: "success", assistant: "success" };

	// Exactly the shape of run 28460012584 (0.12.52).
	test("unit=platform with every docker job skipped is refused", () => {
		const result = verifyReleaseImages({
			unit: "platform",
			includeImages: true,
			results: ALL_SKIPPED,
		});
		expect(result.ok).toBe(false);
		expect(result.missing.map((m) => m.image).sort()).toEqual(["assistant"]);
	});

	// 0.12.49 (unit=guardian) produced a guardian image and only a guardian image
	// — the partial case must be judged against the unit's OWN expectation, not
	// against "some image was built".
	test("a unit is judged against its own expected image set, not 'some image built'", () => {
		expect(
			verifyReleaseImages({
				unit: "guardian",
				includeImages: true,
				results: { ...ALL_SKIPPED, guardian: "success" },
			}).ok,
		).toBe(true);
		// unit=platform owns only the assistant image; a guardian-only run is short.
		const platform = verifyReleaseImages({
			unit: "platform",
			includeImages: true,
			results: { ...ALL_SKIPPED, guardian: "success" },
		});
		expect(platform.ok).toBe(false);
		expect(platform.missing.map((m) => m.image)).toEqual(["assistant"]);
	});

	test.each(["platform", "portals", "assistant", "guardian", "images", "all"])(
		"unit=%s passes when its expected images built, and fails when they were skipped",
		(unit) => {
			expect(verifyReleaseImages({ unit, includeImages: true, results: ALL_BUILT }).ok).toBe(true);
			// Every one of these units expects at least one image with the flag on,
			// so all-skipped must be refused for all of them.
			expect(expectedImages(unit, true).length).toBeGreaterThan(0);
			expect(verifyReleaseImages({ unit, includeImages: true, results: ALL_SKIPPED }).ok).toBe(
				false,
			);
		},
	);

	test("unticking include_images is still a legitimate npm-only thin-host patch", () => {
		// The opt-out must stay usable — the guard exists to catch the SILENT
		// case, not to force images onto a deliberate npm-only release.
		for (const unit of ["platform", "guardian", "portals"]) {
			expect(expectedImages(unit, false)).toEqual([]);
			expect(verifyReleaseImages({ unit, includeImages: false, results: ALL_SKIPPED }).ok).toBe(
				true,
			);
		}
	});

	test("unit=electron expects no images and is unaffected", () => {
		expect(expectedImages("electron", true)).toEqual([]);
		expect(
			verifyReleaseImages({ unit: "electron", includeImages: true, results: ALL_SKIPPED }).ok,
		).toBe(true);
	});

	test("a failed or absent docker job is no more tag-worthy than a skipped one", () => {
		for (const result of ["failure", "cancelled", ""]) {
			expect(
				verifyReleaseImages({
					unit: "assistant",
					includeImages: true,
					results: { ...ALL_BUILT, assistant: result },
				}).ok,
			).toBe(false);
		}
	});
});

// Anti-drift: the guard's expectation table is a hand-written mirror of the
// docker-* jobs' `if:` gates. Evaluate those gates for real and require the two
// to agree — otherwise a future gate edit silently re-opens the hole.
describe("images-with-every-release — the guard's expectations match the docker job gates", () => {
	const release = parseWorkflow(RELEASE_WORKFLOW);
	const jobs = jobsOf(release);
	const IMAGE_JOB_IDS = { portal: "docker-portal", guardian: "docker-guardian", assistant: "docker-assistant" };
	const UNITS = ["platform", "portals", "assistant", "guardian", "images", "electron", "all"];

	/**
	 * Evaluate a workflow `if:` expression with every upstream job healthy, so
	 * only the unit/flag conditions decide. Handles the subset of GitHub's
	 * expression syntax these gates actually use.
	 */
	function gateRuns(expr: string, unit: string, includeImages: boolean): boolean {
		const js = expr
			.replace(/always\(\)/g, "true")
			.replace(/inputs\.unit/g, JSON.stringify(unit))
			.replace(/inputs\.include_images/g, String(includeImages))
			.replace(/inputs\.dry_run/g, "false")
			.replace(/needs\.[\w-]+\.result/g, '"success"')
			.replace(/!=/g, "!==")
			.replace(/(?<![!=])==(?!=)/g, "===");
		return Boolean(new Function(`return (${js});`)());
	}

	test("the evaluator actually discriminates (guards against a rubber-stamp)", () => {
		// If gateRuns returned a constant, every agreement assertion below would
		// be vacuous. Pin one gate that must differ across units.
		const portalGate = String(jobs["docker-portal"]?.if ?? "");
		expect(gateRuns(portalGate, "images", true)).toBe(true);
		expect(gateRuns(portalGate, "electron", true)).toBe(false);
	});

	for (const unit of UNITS) {
		for (const includeImages of [true, false]) {
			test(`unit=${unit} include_images=${includeImages}: gates and guard agree`, () => {
				const wouldRun = Object.entries(IMAGE_JOB_IDS)
					.filter(([, jobId]) => gateRuns(String(jobs[jobId]?.if ?? ""), unit, includeImages))
					.map(([image]) => image)
					.sort();
				expect(expectedImages(unit, includeImages)).toEqual(wouldRun);
			});
		}
	}
});
