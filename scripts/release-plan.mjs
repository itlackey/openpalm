#!/usr/bin/env node
// Resolve the platform-release "unit" selection into the flags, manifest set, and
// Docker image matrix the orchestrator (.github/workflows/platform-release.yml)
// fans out on. Reads the release_* selection from the environment, writes GitHub
// Actions job outputs to $GITHUB_OUTPUT (and a human summary to
// $GITHUB_STEP_SUMMARY when present). Lives in a file — NOT inline `node -e` —
// because a large inline script in a YAML run block silently mis-executed in CI.
//
// Env in:  REL_HOST REL_UI REL_PORTALS REL_ASSISTANT REL_VOICE ('true'/'false'), VERSION
// Out:     full do_host do_ui do_portals do_assistant do_voice do_tag image_matrix manifests
//
// Units come from .github/release-package-groups.json -> units. Run locally to
// preview a plan:  REL_PORTALS=true VERSION=0.11.1 node scripts/release-plan.mjs

import fs from "node:fs";

const groups = JSON.parse(fs.readFileSync(".github/release-package-groups.json", "utf8"));
const units = groups.units;
const bool = (v) => v === "true";

const relHost = bool(process.env.REL_HOST);
const relUi = bool(process.env.REL_UI);
const relPortals = bool(process.env.REL_PORTALS);
const relAssistant = bool(process.env.REL_ASSISTANT);
const relVoice = bool(process.env.REL_VOICE);
const version = process.env.VERSION || "";
const isPre = version.includes("-");

// Full = nothing selected at all -> host + portals + assistant (NOT voice; voice
// is heavy + stable-only, so it is always explicit). Selecting ONLY voice must NOT
// trigger a full release, so voice counts toward "anything selected" even though
// it never contributes to the core trio.
const full = !(relHost || relUi || relPortals || relAssistant || relVoice);
const doHost = full || relHost;
const doUi = doHost || relUi;
const doPortals = full || relPortals;
const doAssistant = full || relAssistant;
const doVoice = relVoice && !isPre; // stable only, always explicit
const doTag = full || doHost; // tag + GitHub release for host + full only

if (relVoice && isPre) {
  console.log("::notice::voice is stable-only — skipping voice for prerelease " + version);
}

// Manifests to stamp + regression-guard. Full uses coordinatedManifests
// (== units.host + units.portals); a partial selection unions the picked units.
const picked = [];
if (doHost) picked.push("host");
else if (doUi) picked.push("ui");
if (doPortals) picked.push("portals");
if (doAssistant) picked.push("assistant");
const manifests = full
  ? groups.coordinatedManifests
  : [...new Set(picked.flatMap((u) => units[u] || []))];

// Image matrix: portals => guardian + portal; assistant => assistant.
const include = [];
if (doPortals) {
  include.push({ dockerfile: "containers/guardian/Dockerfile", image: "openpalm/guardian" });
  include.push({ dockerfile: "containers/portal/Dockerfile", image: "openpalm/portal" });
}
if (doAssistant) include.push({ dockerfile: "containers/assistant/Dockerfile", image: "openpalm/assistant" });

const out = process.env.GITHUB_OUTPUT;
if (out) {
  const lines = [
    `full=${full}`,
    `do_host=${doHost}`,
    `do_ui=${doUi}`,
    `do_portals=${doPortals}`,
    `do_assistant=${doAssistant}`,
    `do_voice=${doVoice}`,
    `do_tag=${doTag}`,
    `image_matrix=${JSON.stringify({ include })}`,
    `manifests=${JSON.stringify(manifests)}`,
  ];
  fs.appendFileSync(out, lines.join("\n") + "\n");
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  let md = `### Release plan — ${version}\n\n`;
  md += "| unit | release? |\n|---|---|\n";
  md += `| host | ${doHost} |\n| web ui | ${doUi} |\n| portals | ${doPortals} |\n| assistant | ${doAssistant} |\n| voice | ${doVoice} |\n`;
  md += `\n**mode:** ${full ? "full coordinated" : "partial"} · **tag+release:** ${doTag}\n\n`;
  md += `**manifests stamped:** ${manifests.length ? manifests.join(", ") : "(none — image-only)"}\n`;
  fs.appendFileSync(summary, md);
}

console.log(JSON.stringify({ full, doHost, doUi, doPortals, doAssistant, doVoice, doTag, manifests, include }, null, 2));
