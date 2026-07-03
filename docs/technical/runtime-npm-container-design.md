# Runtime NPM Container Design

## 1. **Current State**

The current portal container is already a thin _runner_ in shape, but not in release mechanics. It still bakes first-party portal source trees and installs their dependencies during the Docker build.

- `containers/portal/Dockerfile:12-20` copies `portals/discord` and `portals/slack` into the image and runs `bun install --production` in each package.
- `containers/portal/Dockerfile:22-37` then copies a small entrypoint wrapper and runs the image as `bun`.
- `containers/portal/portal-entrypoint.ts:20-24` assumes each adapter is baked at a fixed filesystem path under `/app/portals` and imports it by path, not by package resolution.
- `containers/portal/start.sh:4-16` requires `PORTAL_PACKAGE`, but the value only selects among already-baked adapters; it does not install anything.
- `containers/portal/README.md:3-15,48-50` explicitly documents that the image bakes the adapters and that there is no runtime install path.

The deploy model reflects that baked-image assumption.

- `.openpalm/config/stack/portals.compose.yml:9,43` runs both Discord and Slack from the same `openpalm/portal` image.
- `.openpalm/config/stack/portals.compose.yml:17,51` sets `PORTAL_PACKAGE` to `@openpalm/discord-portal` or `@openpalm/slack-portal`, but that value is only a selector for code already copied into the image.
- `.openpalm/config/stack/portals.compose.yml:9,43,72` ties portal and guardian service selection to Docker image tags, not npm package versions.

This requires frequent Docker rebuilds because any portal code change changes the image payload.

- `containers/portal/Dockerfile:12-20` couples adapter code, dependency resolution, and runtime into one image artifact.
- `.github/workflows/release.yml:302-348` rebuilds and republishes `openpalm/portal` for the `portals` unit.
- `.github/workflows/release.yml:349-392` also rebuilds `openpalm/guardian` for `unit=portals`, because guardian currently rides the same release unit.

Current versioning is image-centric and unit-centric.

- `docs/technical/release-architecture.md:34-37` defines separate `platform`, `portals`, `assistant`, and `guardian` release units.
- `docs/technical/release-architecture.md:49-55` states the portal packages are private, not published to npm, and are baked into `openpalm/portal`.
- `scripts/bump-unit.mjs:94-101` stamps `portals/discord/package.json` and `portals/slack/package.json` together for a portals release.
- `.github/workflows/release.yml:304-348` publishes a Docker image for portals; there is no npm publish job for portal adapters.

The current package model is close to publishable, but not actually published.

- `portals/discord/package.json:2-5` is named `@openpalm/discord-portal`, versioned, and marked `private: true`.
- `portals/slack/package.json:2-5` is named `@openpalm/slack-portal`, versioned, and marked `private: true`.
- Both packages already have `repository`, `license`, `files`, and `main` metadata (`portals/discord/package.json:7-20`, `portals/slack/package.json:7-20`).

> **Update (superseded):** The duplicated runtime/helper layer described in this
> section has since been extracted into the shared `@openpalm/portal-sdk`
> package (`packages/portal-sdk/`, exporting `BasePortal`, `OcClient`, the event
> interpreters, and `renderTurn`). The per-portal `runtime.ts`/`oc-events.ts`
> copies referenced below no longer exist; both adapters now build on the SDK.
> The distribution/publication analysis below is retained as a historical record.

The current repo no longer contains the `packages/channels-sdk/` path requested in the research brief. In the current tree, the portal packages do not depend on a shared internal SDK package. Instead, they duplicate a small runtime/helper layer.

- `portals/discord/src/runtime.ts:1-211` and `portals/slack/src/runtime.ts:1-211` are effectively parallel copies.
- Both portal packages depend directly on `@opencode-ai/sdk` plus their protocol library (`portals/discord/package.json:21-24`, `portals/slack/package.json:21-24`).

The broader platform already has a proven thin-harness precedent in Electron.

- `docs/technical/core-principles.md:214-227` defines Electron as a thin native harness whose UI/control-plane payload self-updates separately over npm.
- `packages/electron/src/main.ts:12-26,182-242` imports platform version helpers and avoids leaking image-tag env into deploy operations.
- `packages/electron/src/main.ts:385-432` updates the UI payload separately from the harness.

That precedent is conceptually aligned with a thin portal image whose changing logic arrives from npm instead of from Docker layers.

## 2. **Design Goals**

The refactor should deliver these properties:

- Keep the container image thin: runtime, package manager, entrypoint, and minimal diagnostics only.
- Move frequent portal releases from Docker publishing to npm publishing.
- Select portal package versions by environment variables.
- Default to the current major line only, so older installs never float across a breaking major.
- Allow exact-version pinning for rollback, testing, or incident response.
- Reuse the same pattern later for guardian and assistant with as little special casing as possible.
- Preserve OpenPalm core principles: host-controlled config, explicit mounts, user-accessible persistent state, and no extra orchestrator complexity.

## 3. **Research Findings**

### Established package-install behavior

- `npm install` can install a specific package name, version, dist-tag, range, tarball, or URL, and supports production-only installs and exact version specs. Source: npm CLI docs, `npm install`, <https://docs.npmjs.com/cli/v10/commands/npm-install>.
- `npm ci` is lockfile-driven, removes existing `node_modules`, never mutates the lockfile, and requires a pre-existing `package-lock.json` or shrinkwrap. It is suited to reproducible reinstalls, not first-time dynamic resolution. Source: npm CLI docs, `npm ci`, <https://docs.npmjs.com/cli/v10/commands/npm-ci>.
- `npm exec`/`npx` can fetch remote packages into the npm cache and run their binaries, but this is intentionally cache-oriented and command-oriented, not a durable installation model with explicit rollback state. Source: npm CLI docs, `npm exec`, <https://docs.npmjs.com/cli/v10/commands/npm-exec>.

What applies to OpenPalm:

- `npm install` is the right primitive for first install and upgrade into a controlled runtime directory.
- `npm ci` is useful only after an exact version has already been resolved and a lockfile has been materialized.
- `npm exec` is attractive for prototypes, but too implicit for a core runtime that needs auditability, exact-state inspection, and predictable restarts.

### Locking, integrity, and provenance

- `package-lock.json` records the exact resolved tree, including tarball `resolved` URLs and `integrity` hashes, and is intended to guarantee identical subsequent installs. Source: npm docs, `package-lock.json`, <https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json>.
- npm provenance ties published artifacts to CI build identity and Sigstore transparency logs; trusted publishing removes long-lived publish tokens. Sources: npm docs, `Generating provenance statements`, <https://docs.npmjs.com/generating-provenance-statements>; npm docs, `Trusted publishing for npm packages`, <https://docs.npmjs.com/trusted-publishers>.
- `npm audit signatures` verifies registry signatures and provenance attestations for downloaded packages. Source: npm CLI docs, `npm audit`, <https://docs.npmjs.com/cli/v11/commands/npm-audit>.

What applies to OpenPalm:

- Runtime package installation should prefer exact version resolution plus persisted `package-lock.json`, not free-floating reinstall on every boot.
- First-party portal packages should publish through trusted publishing with provenance enabled.
- The runtime installer should fail closed if signature/provenance verification for first-party packages fails.

### Version selection and channels

- npm dist-tags are a first-class way to expose moving channels such as `latest` or `beta`, while exact versions and semver ranges remain available for deterministic selection. Sources: npm docs, `Adding dist-tags to packages`, <https://docs.npmjs.com/adding-dist-tags-to-packages>; npm docs, `npm view`, <https://docs.npmjs.com/cli/v10/commands/npm-view>.

What applies to OpenPalm:

- Dist-tags are useful for prerelease channels, but the default stable behavior should remain an explicit major-bounded semver range, because OpenPalm must not silently cross major boundaries.
- `npm view <pkg>@<range> version --json` is a practical way to resolve the newest allowed exact version before install.

### Persistent caching and mounted install roots

- Docker volumes are the preferred persistence mechanism for container-generated data because they outlive container replacement and avoid container writable-layer penalties; mounting over existing paths obscures pre-existing image files. Source: Docker docs, `Volumes`, <https://docs.docker.com/engine/storage/volumes/>.
- Grafana supports startup-time plugin installation using environment variables and also supports pre-baking those plugins for faster startup when desired. Source: Grafana Docker docs, `Install plugins in the Docker container`, <https://grafana.com/docs/grafana/latest/setup-grafana/configure-docker/#install-plugins-in-the-docker-container>.

What applies to OpenPalm:

- The portal runtime should install to a persistent mounted directory, not to the container writable layer.
- OpenPalm should keep using host-visible persistent storage rather than opaque Docker-managed named volumes, to stay aligned with its filesystem contract.
- Runtime-install plus optional pre-bake is a known pattern in adjacent plugin systems.

### Bun-specific considerations

- Bun installs fast, has a global cache, supports exact versions and production installs, and can enforce a minimum release age when resolving packages. Source: Bun docs, `bun install`, <https://bun.sh/docs/pm/cli/install>.
- Bun intentionally does not run lifecycle scripts of installed dependencies by default unless packages are trusted. Sources: Bun docs, `bun install`, <https://bun.sh/docs/pm/cli/install>; Bun docs, `bun add`, <https://bun.sh/docs/pm/cli/add>.
- Bun exposes package-manager utilities such as `bun pm pack` and cache inspection. Source: Bun docs, `bun pm`, <https://bun.sh/docs/pm/cli/pm>.

What applies to OpenPalm:

- Bun remains a good runtime for executing published portal packages.
- Bun is less attractive as the primary runtime installer for first-party packages because OpenPalm specifically wants an npm-centered release flow with npm provenance and npm-native verification.
- Bun's minimum release age is interesting for future hardening, but it is not a substitute for exact version resolution and lockfile persistence.

## 4. **Proposed Architecture**

### Thin image contents

The portal image should contain only:

- Bun runtime for executing portal code.
- A supported npm CLI for runtime package installation.
- A small portal bootstrap entrypoint.
- Minimal diagnostics tools already justified for health checks.

It should not contain:

- `portals/discord` source.
- `portals/slack` source.
- Per-portal `node_modules` trees.

### Published package model

Keep the current package names unless there is a branding reason to rename them.

- Keep `@openpalm/discord-portal`.
- Keep `@openpalm/slack-portal`.

This is the lowest-churn path because those names already appear in compose (`.openpalm/config/stack/portals.compose.yml:17,51`) and in the current manifests (`portals/discord/package.json:2`, `portals/slack/package.json:2`).

Required packaging changes:

- Remove `private: true` from both portal package manifests.
- Publish each package independently to npm.
- Preserve the existing Bun-friendly module entry if desired, but add one stable runtime contract:
  - either a `bin` entry, or
  - a documented default export / bootstrap function that the container entrypoint imports by bare package specifier.

Shared code recommendation:

- Do not resurrect a broad `channels-sdk` package just for this refactor.
- Extract only the duplicated runtime/helper layer from `portals/discord/src/runtime.ts` and `portals/slack/src/runtime.ts` into a small shared package such as `@openpalm/portal-runtime` once publication begins.
- Version that shared runtime in the same major line as the portal packages and consume it via a normal semver dependency.

That is a modest restructure, not a repo-wide rewrite.

### Runtime install flow

Use a persistent install root under service-owned data, for example:

- Host: `$OP_HOME/data/portals/<portal-name>/`
- Container: `/opt/openpalm/portal/`

Recommended layout:

- `/opt/openpalm/portal/current/` — active generated project, `node_modules`, `package-lock.json`
- `/opt/openpalm/portal/cache/npm/` — npm cache
- `/opt/openpalm/portal/state/current.json` — resolved package metadata
- `/opt/openpalm/portal/staging/` — temporary install target for atomic swaps

This stays aligned with the filesystem contract better than anonymous or named Docker volumes because the state remains host-visible and backup-friendly.

### ENV version/range scheme

Recommended scheme:

- `PORTAL_PACKAGE=@openpalm/discord-portal`
- `OP_PORTAL_PACKAGE_RANGE=>=0.12.0 <1.0.0`
- Optional per-service exact override: `PORTAL_PACKAGE_VERSION=0.12.7`
- Optional per-service custom registry override: `PORTAL_NPM_REGISTRY=https://registry.npmjs.org`

Resolution order:

1. If `PORTAL_PACKAGE_VERSION` is set, install exactly that version.
2. Otherwise, resolve the newest version satisfying `OP_PORTAL_PACKAGE_RANGE`.
3. If neither is set, fall back to the seeded default major-bounded range for the current major line.

Why one global range plus per-service exact override is the best default:

- Discord and Slack are first-party portal adapters in one release family today.
- Major-line movement stays coordinated by default.
- Rollback/testing remains granular because `PORTAL_PACKAGE_VERSION` can pin one service without changing the family default.

How major boundaries are handled cleanly:

- Before a major release, change the seeded default from, for example, `>=0.12.0 <1.0.0` to `>=1.0.0 <2.0.0`.
- Existing installs retain their persisted older value until an operator changes it, which prevents old stacks from absorbing the next major automatically.
- New installs seed the new major-bounded default.

This mirrors the existing principle that host config persists and is not silently overwritten.

### Recommended install mechanism

Use npm for installation and Bun for execution.

Recommended install behavior:

- Generate a minimal local `package.json` in `/opt/openpalm/portal/current` with one dependency: the exact resolved portal package version.
- Install with `npm install --omit=dev` on first install or upgrade.
- Persist the generated `package-lock.json`.
- On later cold starts, skip reinstall entirely if the resolved version and lockfile state already match.
- If the install root is missing but the lockfile matches the desired exact version, use `npm ci --omit=dev` for a deterministic rebuild.

Do not use `npm exec`/`npx` as the steady-state path.

Reasons:

- They are optimized for command execution from cache, not for a durable service runtime.
- They make install state and rollback less explicit.
- They complicate atomic swap and state-file validation.

### Caching and update behavior

At startup, the entrypoint should:

- Resolve the exact desired version first.
- Compare it with `state/current.json`.
- Reuse the installed tree when the exact version matches and the package manifest in `node_modules` matches.
- Install only when the exact desired version changed or the install root is missing/corrupt.

Suggested hardening for first-party packages:

- After install, run `npm audit signatures` in the generated project.
- Fail startup if first-party package signature/provenance verification fails.
- Record the resolved version and verification result in `state/current.json`.

Suggested startup algorithm:

```text
read env
require PORTAL_PACKAGE
selector = PORTAL_PACKAGE_VERSION ? exact version : OP_PORTAL_PACKAGE_RANGE
resolved = npm view "${PORTAL_PACKAGE}@${selector}" version --json

if state.current.resolvedVersion == resolved
  and current/node_modules/<package>/package.json version == resolved:
  exec bun bootstrap using current install root

prepare staging dir
write staging/package.json with dependency pinned to exact resolved version
npm install --omit=dev in staging
npm audit signatures in staging
write staging/state/current.json with requested selector, resolved version, timestamps, verification result
atomically swap staging -> current
exec bun bootstrap using current install root
```

Execution path after install:

- Set working directory to `/opt/openpalm/portal/current`.
- Import `PORTAL_PACKAGE` by bare package name, not by hard-coded filesystem path.
- Keep the current wrapper contract of validating the module and calling `start()`.

## 5. **Release Process Changes**

### Frequent-release path becomes npm-first

Portal code changes should normally publish npm packages only.

Conceptually:

- `@openpalm/discord-portal` publishes on ordinary portal changes.
- `@openpalm/slack-portal` publishes on ordinary portal changes.
- Optional `@openpalm/portal-runtime` publishes when shared runtime changes.

Docker release cadence drops sharply.

- Rebuild `openpalm/portal` only when the image harness changes: Bun version, npm CLI/runtime tooling, healthcheck behavior, entrypoint behavior, CA bundle, base image hardening, or other non-package runtime concerns.
- This is the same boundary that Electron uses for deciding when the native harness must be re-downloaded versus when the payload self-updates (`docs/technical/core-principles.md:214-227`).

### Workflow and script simplification

Current complexity:

- `.github/workflows/release.yml:304-348` always rebuilds and republishes `openpalm/portal` for the portals unit.
- `scripts/bump-unit.mjs:94-101` stamps private package versions that never leave the repo as npm artifacts.

Target simplification:

- Publish portal packages through the existing npm trusted-publishing path.
- Move the portals unit from “Docker artifact is the primary changing thing” to “npm package is the primary changing thing.”
- Keep a much slower `portal-runtime` image release track.

Conceptual workflow shape:

- `portals` frequent release:
  - bump and publish portal npm package(s)
  - maybe update dist-tags
  - no Docker build unless the harness changed
- `portal-image` rare release:
  - bump and publish thin image only
  - optionally coordinated with major releases

`scripts/bump-unit.mjs` should eventually split package bumps from image-harness bumps, because the current `portals` unit conflates them.

### Admin UI version source strategy

Current UI/control-plane versioning logic is image-tag-oriented (`packages/lib/src/control-plane/image-tags.ts:1-118`, `packages/lib/src/control-plane/lifecycle.ts:748-859`).

Future direction:

- Keep image tag controls for the rare harness image line.
- Add package-range and exact-package-version controls for the frequent portal runtime line.
- Populate package version pickers from npm metadata, not Docker Hub tags.
- Preserve the existing image pinning concepts for rollback, but apply them to package versions/ranges at the runtime layer.

## 6. **Applying The Pattern To Guardian And Assistant**

### What stays the same

- Thin image idea.
- Runtime-resolved package version or major-bounded range.
- Persistent mounted install root.
- Entry-point controlled exact-version resolution, skip-if-unchanged behavior, and atomic swaps.
- npm trusted publishing plus provenance as the frequent release path.

### Guardian

Guardian is a strong candidate for the same pattern, but not all of it should move out of the image.

What can become runtime-installed later:

- The Bun application code under `packages/guardian/src/`.

What likely stays baked:

- OpenCode installation/bootstrap expectations (`containers/guardian/Dockerfile:15-26`).
- OS-level packages required by the OpenCode installer and runtime (`containers/guardian/Dockerfile:10-13`).
- The small entrypoint that starts the moderator and API sidecar process (`containers/guardian/entrypoint.sh:20-44`).

Key difference from portals:

- Guardian is security-critical ingress, so fail-closed runtime verification matters more here than startup speed.
- The verification bar should be stricter than for portals.

### Assistant

Assistant is the least likely to become fully runtime-installed in one step.

What can eventually move to npm-first frequent release behavior:

- OpenPalm-specific assistant config payloads, tools, and non-native JS helpers.

What likely stays baked for longer:

- OpenCode installation (`containers/assistant/Dockerfile:60-65`).
- Bun installation and CLI toolchain bootstrap (`containers/assistant/Dockerfile:67-101`).
- Baked embedder/model assets (`containers/assistant/Dockerfile:12-28,104-127`).
- Non-JS runtime dependencies like `gh`, `gcloud`, `gws`, SSH, cron, database clients, and `uv` (`containers/assistant/Dockerfile:43-58,139-170`).
- Entry-point logic that manages UID/GID, SSH, cron, AKM migration, and startup orchestration (`containers/assistant/entrypoint.sh:10-243`).

Recommended framing:

- Portal is the proving ground.
- Guardian is the next realistic adopter.
- Assistant should probably adopt the pattern only for selected payload layers, not for its full runtime image.

## 7. **Risks And Tradeoffs**

### Startup latency

Risk:

- First boot after package change will be slower than today.

Mitigations:

- Persistent install root and cache.
- Skip reinstall when resolved version is unchanged.
- Rare-image / frequent-package split means most restarts do not pay a Docker pull cost.

### Security and supply chain

Risk:

- Runtime network fetch during startup expands the operational attack surface.

Mitigations:

- First-party packages published with trusted publishing and provenance.
- Resolve to an exact version before install.
- Persist and inspect `package-lock.json` with integrity hashes.
- Run `npm audit signatures` for first-party installs.
- Keep default range major-bounded.

### Offline or air-gapped support

Risk:

- Fresh startup on an empty cache cannot install from npm without network access.

Mitigations:

- Persist install roots so ordinary restarts stay offline once installed.
- Support pre-seeded tarballs or private registry mirrors later.
- Keep rare pre-baked image releases available for fully offline environments if maintainers decide that is required.

### Runtime complexity versus build complexity

Tradeoff:

- Complexity moves from CI Docker builds into the container bootstrap path.

Assessment:

- This is justified if the bootstrap remains small, deterministic, and stateful.
- It is not justified if the runtime installer becomes a second package manager/orchestrator.

The design above avoids that failure mode by keeping the algorithm narrow: resolve exact version, install into one mounted directory, verify, swap, run.

### Rollback behavior

Benefit:

- Exact package-version pinning makes rollback faster and narrower than rebuilding old images.

Requirement:

- Keep the previous exact version installable and operator-visible.
- Surface the active resolved version in logs/status/UI.

## 8. **Recommended Migration Plan**

### Phase 1: Make portal packages publishable

- Remove `private: true`.
- Add any missing publish metadata.
- Add a stable runtime contract (`bin` or documented bootstrap export).
- Publish through the existing npm trusted-publishing workflow.

### Phase 2: Introduce thin portal image

- Stop copying `portals/discord` and `portals/slack` into `containers/portal/Dockerfile`.
- Add persistent portal data mounts under `data/portals/<service>/`.
- Change the portal entrypoint to resolve, install, verify, cache, and run packages from the mounted install root.

### Phase 3: Add env-driven version controls

- Seed `OP_PORTAL_PACKAGE_RANGE` to the current-major bounded default.
- Add optional per-service exact overrides like `PORTAL_PACKAGE_VERSION`.
- Surface resolved package versions in logs and operator UI.

### Phase 4: Split release tracks

- Make portal npm publishes the common path.
- Make portal image publishes rare and harness-only.
- Update docs and operator guidance to distinguish image version from runtime package version.

### Phase 5: Apply pattern to guardian

- Extract guardian app code into a publishable package.
- Keep OpenCode/runtime bootstrap baked.
- Reuse the same mounted install-root and exact-version resolution pattern.

### Phase 6: Selective assistant adoption

- Apply the model only to payload layers that are genuinely JS-package-shaped.
- Do not force model bundles, OS packages, or heavy CLI bootstrap into runtime npm installation.

Compatibility considerations:

- Existing installs must keep working with current image-tag controls during rollout.
- The first migration should preserve `PORTAL_PACKAGE` values already present in compose.
- Config seeding must respect non-destructive host config rules.

## 9. **Open Questions**

- Should the portal thin image standardize on `node + npm + bun`, or should maintainers verify and rely on npm availability in the existing `oven/bun` base image?
- Do maintainers want a small shared published runtime package now, or is one round of duplicated published portal packages acceptable before extracting `@openpalm/portal-runtime`?
- Should the control plane expose portal package version management in `stack.env`, a separate operator-managed file, or both?
- Is offline/air-gapped startup from an empty install root a hard requirement, or is “works offline after first successful install” sufficient for the first iteration?
- Should guardian remain coupled to the portals release line during the transition, or should its independent release line be enforced before the thin-image runtime-install pattern reaches it?
- Should prerelease channels be exposed via npm dist-tags in the operator UI, or should the first version picker support exact versions and semver ranges only?
