# Release Architecture

> Last updated 2026-07-28.

## Invariants

- `.github/workflows/release.yml` is the only version authority.
- One run creates one stamped candidate commit directly atop its dispatch SHA.
- Preflight and every publisher consume that exact candidate bundle.
- Live source is pushed only after preflight and only if the target branch still
  equals the recorded base SHA.
- Every package manifest has one canonical release owner.
- Release runs are globally serialized. Immutable registry and Git targets are
  checked before source publication, and selected Docker targets must advance
  the complete paginated tag history for each image.
- Git tags and GitHub releases are created last.

`.github/workflows/publish-npm-package.yml` is callable only by the orchestrator.
It verifies an already-stamped version, packs the restored candidate, and
publishes through npm trusted publishing. It cannot bump or commit source.

## Release Units

| Unit | Canonical stamp set | Published artifacts |
|---|---|---|
| `platform` | root, skeleton, lib, CLI, UI, UI kit, setup scripts | skeleton/lib/CLI/UI npm, CLI binaries, assistant image by default |
| `portals` | portal SDK, Discord, Slack, baked adapter pins | three npm packages and portal image by default |
| `guardian` | Guardian manifest | Guardian npm and Guardian image by default |
| `electron` | Electron and admin-tools manifests | macOS/Linux/Windows installers |
| `assistant` | `containers/assistant/VERSION` | Assistant image |
| `images` | none | Assistant, Guardian, and portal images at a required explicit version |
| `all` | every stamp set above at one version | all eight npm packages, three standard images, CLI binaries, and Electron installers |

The groups in `.github/release-package-groups.json` are disjoint and are the
manifest-list source used by `scripts/bump-unit.mjs`. CI validates internal
version equality for each group.

Voice is not a release.yml unit. `.github/workflows/publish-voice.yml` requires
its own immutable base version and release cadence.

## Candidate Flow

1. `compute-version` computes the target and fails closed on npm query errors.
2. It rejects existing target Git tags and Docker image tags, and rejects a
   selected image version that does not exceed its Docker Hub history. `images`
   without an explicit version is rejected.
3. `bump` stamps the selected owner set, refreshes `bun.lock`, commits once, and
   uploads an incremental git bundle.
4. `preflight` restores the bundle, installs with `--frozen-lockfile`, and tests
   that exact candidate.
5. `release-source` restores the tested candidate and, for a live run, pushes it
   with a base-SHA `--force-with-lease`. It never rebases.
6. npm, Docker, CLI, and Electron jobs restore the same bundle.
7. The final job verifies every expected npm, image, CLI, and Electron job,
   promotes stable Docker `latest` aliases from the signed build digests, then
   creates Git tags and GitHub releases.

`dry_run=true` performs the same stamping, frozen install, tests, package packs,
and local image assembly without pushing source or registries.

## Package DAG

Platform publishing orders skeleton before lib, then CLI and UI after lib. The
CLI's exact skeleton dependency and internal lib floor are stamped by
`scripts/set-version.mjs` in dependencies, peer dependencies, and dev
dependencies where present.

Portal publishing orders `@openpalm/portal-sdk` before both adapters. A live
portal image waits for all three npm publishes, then installs the exact published
adapter versions from `containers/portal/tools/package.json`. `bun pm pack`
resolves runtime `workspace:*` dependencies in those published packages to the
candidate versions.

Guardian has no OpenPalm npm dependency and publishes independently. Skeleton
belongs to platform, not Guardian. The Guardian image still bakes both packages,
but receives separate `GUARDIAN_VERSION` and `SKELETON_VERSION` build arguments.

Electron manifests form their own unit. A platform-only release does not stamp
or build Electron; `all` composes both units.

## Image Assembly

- Assistant bakes UI and skeleton at `PLATFORM_VERSION`.
- Guardian bakes independently versioned Guardian and skeleton packages.
- Portal installs exact published Discord and Slack adapter pins at build time;
  it does not copy workspace adapter source.
- Image entrypoints do not install ordinary release content at boot.

Coordinated dry runs substitute candidate tarballs where the target version is
not yet on npm. Live portal builds and standalone image units use registry-backed
packages and validate their exact pins before building.

Docker build jobs push only immutable version tags. For a stable release, the
final release job aliases each verified build digest to `latest` only after all
required artifacts succeed. Prereleases do not move `latest`.

Voice follows the same late-promotion rule inside its independent workflow:
both immutable CPU/CUDA variants must build and verify before either
`latest-<variant>` alias moves. Prereleases do not move those aliases.

Assistant and Voice model bundles accept only increasing immutable `vN` tags.
They push, sign, and verify that tag before promoting `latest` from its digest.

## npm Dist-Tags

| Version | Dist-tag |
|---|---|
| `X.Y.Z-rc.N` | `rc` |
| `X.Y.Z-beta.N` | `beta` |
| Other prerelease | `next` |
| Stable | `latest` |

npm trusted publishing currently authorizes `npm publish`, not `npm dist-tag`.
Therefore npm dist-tags move package-by-package during publication; there is no
cross-package transaction. The workflow mitigates this with complete
preflight, disjoint ownership, target collision checks, and tag-last semantics,
but a late failure can leave immutable npm versions and their dist-tags
partially published. Do not reuse that version.

## Git Tags

| Unit | Tags |
|---|---|
| `platform` | `platform-X.Y.Z`, `X.Y.Z` |
| `portals` | `portals-X.Y.Z` |
| `assistant` | `assistant-X.Y.Z` |
| `guardian` | `guardian-X.Y.Z` |
| `electron` | `electron-X.Y.Z` |
| `images` | `images-X.Y.Z` |
| `all` | `platform-X.Y.Z`, `portals-X.Y.Z`, `assistant-X.Y.Z`, `guardian-X.Y.Z`, `electron-X.Y.Z`, and `X.Y.Z` (no `images-X.Y.Z`) |

Tags are bare semver without a `v` prefix and may never move.

## Verification

Static release guards:

```bash
bun test scripts/set-version.test.ts \
  scripts/release-publish-dag.test.ts \
  scripts/release-aggregates-hygiene.test.ts
```

Also run `actionlint`, parse every workflow as YAML, and execute a coordinated
dry run before a live release.
