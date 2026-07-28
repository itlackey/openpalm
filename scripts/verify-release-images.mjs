#!/usr/bin/env node
/**
 * TAG-LAST guard: refuse to tag a release whose expected publish jobs were SKIPPED.
 *
 * Why this exists. release.yml's tag-release gates on
 * `!contains(needs.*.result, 'failure')`. A skipped job is not a failure, so
 * when the three docker-* jobs were gated off (include_images defaulted to
 * false while release practice had drifted to unit=platform), the workflow
 * published npm packages, created a git tag and cut a GitHub release while
 * shipping no images at all — and reported success. Releases 0.12.43 and
 * 0.12.45–0.12.52 have no images on Docker Hub for exactly this reason.
 *
 * Flipping the include_images default fixes the common path; this guard is
 * what makes the silent variant impossible rather than merely unlikely. It
 * runs as the FIRST step of tag-release, before any tag is created, and fails
 * the job loudly — a job-level `if:` would SKIP tag-release instead, which is
 * the same silence in a different place.
 *
 * The expectation table below MIRRORS the `if:` gates on the docker-portal,
 * docker-guardian and docker-assistant jobs. scripts/release-publish-dag.test.ts
 * evaluates those gates directly and asserts they agree with this table for
 * every unit x include_images combination, so the two cannot drift apart.
 */

/** Docker image jobs in release.yml, keyed by the image they publish. */
export const IMAGE_JOBS = /** @type {const} */ (["portal", "guardian", "assistant"]);

/**
 * Which images a release of `unit` is expected to build.
 *
 * @param {string} unit - release.yml's `inputs.unit`.
 * @param {boolean} includeImages - release.yml's `inputs.include_images`.
 * @returns {string[]} image names, sorted, that MUST have been built.
 */
export function expectedImages(unit, includeImages) {
  const expected = [];
  if (unit === "images" || unit === "all" || (unit === "portals" && includeImages)) {
    expected.push("portal");
  }
  if (
    unit === "images" ||
    unit === "all" ||
    (unit === "guardian" && includeImages)
  ) {
    expected.push("guardian");
  }
  if (
    unit === "assistant" ||
    unit === "images" ||
    unit === "all" ||
    (unit === "platform" && includeImages)
  ) {
    expected.push("assistant");
  }
  return expected.sort();
}

/** Non-image jobs whose success is required for each release unit. */
export function expectedArtifactJobs(unit) {
  switch (unit) {
    case "platform":
      return ["npm-skeleton", "npm-lib", "npm-cli", "npm-ui", "cli"].sort();
    case "portals":
      return ["npm-portal-sdk", "npm-discord-portal", "npm-slack-portal"].sort();
    case "guardian":
      return ["npm-guardian"];
    case "electron":
      return ["electron"];
    case "all":
      return [
        "npm-skeleton",
        "npm-lib",
        "npm-guardian",
        "npm-cli",
        "npm-ui",
        "npm-portal-sdk",
        "npm-discord-portal",
        "npm-slack-portal",
        "cli",
        "electron",
      ].sort();
    default:
      return [];
  }
}

export function expectedReleaseJobs(unit, includeImages) {
  return [
    ...expectedArtifactJobs(unit),
    ...expectedImages(unit, includeImages).map((image) => `docker-${image}`),
  ].sort();
}

export function verifyReleaseJobs({ unit, includeImages, results }) {
  const expected = expectedReleaseJobs(unit, includeImages);
  const missing = expected
    .map((job) => ({ job, result: results[job] ?? "" }))
    .filter(({ result }) => result !== "success");
  return { ok: missing.length === 0, expected, missing };
}

export function describeReleaseJobResult({ ok, expected, missing }) {
  if (ok) return `Release jobs succeeded as expected: ${expected.join(", ") || "none"}.`;
  const detail = missing.map(({ job, result }) => `${job} (${result || "no result"})`);
  return `Refusing to tag: expected release job(s) did not succeed: ${detail.join(", ")}.`;
}

/**
 * @typedef {{ ok: boolean, expected: string[], missing: Array<{ image: string, result: string }> }} VerifyResult
 */

/**
 * @param {{ unit: string, includeImages: boolean, results: Record<string, string> }} input
 *   `results` maps image name -> the docker-<image> job's `needs.*.result`.
 * @returns {VerifyResult}
 */
export function verifyReleaseImages({ unit, includeImages, results }) {
  const expected = expectedImages(unit, includeImages);
  const missing = expected
    .map((image) => ({ image, result: results[image] ?? "" }))
    // Anything that is not an outright success means no image was pushed for
    // this version. 'skipped' is the bug this guard exists for; 'failure' and
    // 'cancelled' are already caught upstream, and are still not tag-worthy.
    .filter(({ result }) => result !== "success");
  return { ok: missing.length === 0, expected, missing };
}

/** @param {VerifyResult} result */
export function describeVerifyResult({ ok, expected, missing }) {
  if (ok) {
    return expected.length === 0
      ? "No Docker images expected for this unit — nothing to verify."
      : `Docker images built as expected: ${expected.join(", ")}.`;
  }
  const detail = missing.map(({ image, result }) => `openpalm/${image} (${result || "no result"})`);
  return (
    `Refusing to tag: this release expected ${expected.length} image(s) ` +
    `(${expected.join(", ")}) but ${detail.join(", ")} did not build. ` +
    "A tag must mean the release is fully published. Re-run the release with " +
    "include_images enabled (or unit=images/all), or untick include_images " +
    "deliberately for an npm-only thin-host patch."
  );
}

// CLI entrypoint — release.yml passes the job results through the environment.
if (import.meta.url === `file://${process.argv[1]}`) {
  const unit = process.env.UNIT ?? "";
  const includeImages = process.env.INCLUDE_IMAGES === "true";
  const results = {
    "npm-skeleton": process.env.RESULT_NPM_SKELETON ?? "",
    "npm-lib": process.env.RESULT_NPM_LIB ?? "",
    "npm-guardian": process.env.RESULT_NPM_GUARDIAN ?? "",
    "npm-cli": process.env.RESULT_NPM_CLI ?? "",
    "npm-ui": process.env.RESULT_NPM_UI ?? "",
    "npm-portal-sdk": process.env.RESULT_NPM_PORTAL_SDK ?? "",
    "npm-discord-portal": process.env.RESULT_NPM_DISCORD_PORTAL ?? "",
    "npm-slack-portal": process.env.RESULT_NPM_SLACK_PORTAL ?? "",
    "docker-portal": process.env.RESULT_DOCKER_PORTAL ?? "",
    "docker-guardian": process.env.RESULT_DOCKER_GUARDIAN ?? "",
    "docker-assistant": process.env.RESULT_DOCKER_ASSISTANT ?? "",
    cli: process.env.RESULT_CLI ?? "",
    electron: process.env.RESULT_ELECTRON ?? "",
  };
  const result = verifyReleaseJobs({ unit, includeImages, results });
  const message = describeReleaseJobResult(result);
  if (!result.ok) {
    console.log(`::error::${message}`);
    process.exit(1);
  }
  console.log(message);
}
