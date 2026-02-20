# Versioning & Deployment

OpenPalm uses a **hybrid versioning strategy**: every component can be released
independently, but they can also be released together under a single **platform
version**.

---

## Concepts

| Term | Meaning |
|------|---------|
| **Platform version** | A single semver applied to *all* components at once (e.g. `v0.1.0`). |
| **Component version** | A per-component semver that lets you ship a fix to one service without touching the rest. |
| **`versions.json`** | Single source of truth for every version in the repo. |

### Components

| Component | Artifact | Published to |
|-----------|----------|-------------|
| `opencode-core` | Docker image | Docker Hub |
| `gateway` | Docker image | Docker Hub |
| `admin` | Docker image | Docker Hub |
| `channel-chat` | Docker image | Docker Hub |
| `channel-discord` | Docker image | Docker Hub |
| `channel-voice` | Docker image | Docker Hub |
| `channel-telegram` | Docker image | Docker Hub |
| `cli` | npm package + standalone binaries | npm / GitHub Releases |

### Tag conventions

| Tag pattern | What it triggers |
|-------------|-----------------|
| `v1.2.3` | **Platform release** — publishes all Docker images + CLI |
| `gateway/v1.2.3` | **Component release** — publishes only the gateway image |
| `cli/v1.2.3` | **CLI release** — publishes only the CLI to npm + binaries |
| `<component>/v1.2.3` | **Component release** — publishes only that component's image |

---

## Quick start

```bash
# See all current versions
bun run ver:status

# Bump the entire platform (patch / minor / major)
bun run ver:bump platform patch

# Bump a single component
bun run ver:bump gateway minor

# One-shot: bump + commit + tag (ready to push)
bun run ver:release platform patch

# Push the commit and tags to trigger CI
git push origin HEAD --follow-tags
```

---

## Helper script reference

The version manager lives at `scripts/version.ts` and is accessible via the
`ver` script alias in `package.json`.

### Commands

```
bun run ver status
```
Show every component version and whether it matches the platform version.

```
bun run ver bump <target> <patch|minor|major>
```
Increment the version for `<target>` (a component name or `platform`).
Updates `versions.json`, any associated `package.json` files, and hardcoded
version constants (e.g. the CLI's `VERSION` string).

```
bun run ver set <target> <X.Y.Z>
```
Set an exact version string instead of bumping.

```
bun run ver sync
```
Reset every component version to match the current platform version.

```
bun run ver tag [target]
```
Create annotated git tags for the current versions without committing.
Defaults to `platform` if no target is given.

```
bun run ver release <target> <patch|minor|major>
```
All-in-one: **bump → commit → tag**. After running this, push with:
```bash
git push origin HEAD --follow-tags
```

### Targets

- `platform` (or `all`) — every component shares the same version
- Any component name from the table above (e.g. `gateway`, `cli`, `channel-discord`)

---

## Automated workflows

All workflows live in `.github/workflows/`.

### 1. Release (direct) — `release.yml`

**Trigger:** `workflow_dispatch` from the GitHub Actions UI.

**Inputs:**
- **component** — `platform` or any individual component name
- **bump** — `patch`, `minor`, or `major`

**What it does:**
1. Checks out the repo
2. Runs `bun run scripts/version.ts bump <component> <bump>`
3. Commits the version changes
4. Creates the appropriate git tag (`v*` or `<component>/v*`)
5. Pushes the commit + tag

The tag push then triggers the publish workflows automatically.

**When to use:** Fast releases where you don't need a code review on the
version bump itself.

### 2. Version bump PR — `version-bump-pr.yml`

**Trigger:** `workflow_dispatch` from the GitHub Actions UI.

**Inputs:** Same as the Release workflow.

**What it does:**
1. Creates a `release/<component>/v<version>` branch
2. Bumps the version and commits
3. Opens a pull request targeting your default branch

**After merge:** Create and push the tag manually:
```bash
git pull origin main
git tag -a 'v1.2.3' -m 'Release v1.2.3'
git push origin 'v1.2.3'
```
Or run the Release workflow with the same parameters to tag directly.

**When to use:** When you want a team review on the version bump before
publishing.

### 3. Publish Docker images — `publish-images.yml`

**Triggers:**
- Push of a `v*` tag (platform release — builds all images)
- Push of a `<component>/v*` tag (builds only that component)
- `workflow_dispatch` with a version string and optional component filter

**What it does:**
- Builds multi-arch images (amd64 + arm64) for each selected component
- Pushes to Docker Hub under the `openpalm/` namespace (configurable via
  `DOCKERHUB_NAMESPACE` repo variable)
- Creates multi-arch manifests for `latest` and the version tag

### 4. Publish CLI — `publish-cli.yml`

**Triggers:**
- Push of a `v*` tag (platform release)
- Push of a `cli/v*` tag (independent CLI release)

**What it does:**
- Runs tests and typechecks
- Publishes to npm as `openpalm`
- Cross-compiles standalone binaries (linux-x64, linux-arm64, darwin-x64,
  darwin-arm64)
- Creates a GitHub Release with the binaries attached

---

## Workflows in practice

### Scenario A: Coordinated platform release

Everything ships together with a single version.

```bash
# Option 1 — from your local machine
bun run ver:release platform minor
git push origin HEAD --follow-tags

# Option 2 — from GitHub Actions UI
# Go to Actions → Release → Run workflow
#   component: platform
#   bump: minor
```

**Result:** All Docker images and the CLI are published with the same version.

### Scenario B: Hotfix a single service

Only the gateway needs a patch release.

```bash
# Option 1 — local
bun run ver:release gateway patch
git push origin HEAD --follow-tags

# Option 2 — GitHub Actions UI
# Actions → Release → Run workflow
#   component: gateway
#   bump: patch
```

**Result:** Only the gateway Docker image is rebuilt and pushed. All other
components keep their current versions.

### Scenario C: CLI-only release

```bash
bun run ver:release cli patch
git push origin HEAD --follow-tags
```

**Result:** The CLI is published to npm and new binaries are attached to a
GitHub Release. No Docker images are affected.

### Scenario D: Reviewed release via PR

```
# GitHub Actions UI → Version bump PR → Run workflow
#   component: platform
#   bump: major
```

A PR is created with the version changes. After review and merge, tag and push:
```bash
git pull origin main
git tag -a 'v1.0.0' -m 'Release v1.0.0'
git push origin 'v1.0.0'
```

---

## File layout

```
versions.json                         # ← Source of truth for all versions
scripts/version.ts                    # ← Helper script (bun run ver ...)
package.json                          # ← Root version + ver:* scripts
packages/cli/package.json             # ← CLI npm version
packages/cli/src/main.ts              # ← Hardcoded VERSION constant
.github/workflows/
  release.yml                         # ← Direct release (bump + tag)
  version-bump-pr.yml                 # ← PR-based version bump
  publish-images.yml                  # ← Docker image publishing
  publish-cli.yml                     # ← CLI npm + binary publishing
```

---

## versions.json format

```json
{
  "platform": "0.1.0",
  "components": {
    "opencode-core": "0.1.0",
    "gateway": "0.1.0",
    "admin": "0.1.0",
    "channel-chat": "0.1.0",
    "channel-discord": "0.1.0",
    "channel-voice": "0.1.0",
    "channel-telegram": "0.1.0",
    "cli": "0.1.0"
  }
}
```

When all component versions match the platform version, the project is in a
"synced" state. The `status` command shows this clearly:

```
$ bun run ver:status

OpenPalm Version Status

  Platform:  0.1.0

  Components:
    opencode-core     [image]  0.1.0 ✓ synced
    gateway           [image]  0.1.0 ✓ synced
    admin             [image]  0.1.0 ✓ synced
    channel-chat      [image]  0.1.0 ✓ synced
    channel-discord   [image]  0.1.0 ✓ synced
    channel-voice     [image]  0.1.0 ✓ synced
    channel-telegram  [image]  0.1.0 ✓ synced
    cli               [npm]   0.1.0 ✓ synced
```

After an independent component bump, the diverging component is flagged:

```
    gateway           [image]  0.1.1 ✗ differs
```

Use `bun run ver sync` to realign everything to the platform version.

---

## Deployment with pinned versions

The production `docker-compose.yml` in `assets/state/` already supports
per-image version pinning via environment variables:

```yaml
opencode-core:
  image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/opencode-core:${OPENPALM_IMAGE_TAG:-latest}
```

To pin specific versions per service, override `OPENPALM_IMAGE_TAG` in your
`.env` or set per-service image tags directly in a compose override file:

```yaml
# docker-compose.override.yml
services:
  gateway:
    image: openpalm/gateway:v0.1.1
  admin:
    image: openpalm/admin:v0.1.0
```

This lets you deploy components at different versions even when running from a
single compose stack.

---

## Required secrets and variables

| Name | Type | Used by | Purpose |
|------|------|---------|---------|
| `DOCKERHUB_USERNAME` | Secret | publish-images | Docker Hub login |
| `DOCKERHUB_TOKEN` | Secret | publish-images | Docker Hub access token |
| `NPM_TOKEN` | Secret | publish-cli | npm publish token |
| `DOCKERHUB_NAMESPACE` | Variable | publish-images | Image namespace (default: `openpalm`) |
