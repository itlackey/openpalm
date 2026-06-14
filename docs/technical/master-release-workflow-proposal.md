# Master Platform Release Workflow — Proposal

**Status:** Proposal (investigation only — no workflow changes made)
**Author:** release/CI investigation
**Date:** 2026-06-07
**Scope:** Design a single manually-dispatched "platform release" orchestrator that bumps, syncs, publishes (in dependency order), and recovers from partial failures across every OpenPalm release artifact.

> Ground this against the authoritative knowledge note
> `akm show knowledge:openpalm-release-tracks-and-dispatch-constraints` and
> [`docs/operations/release-management.md`](../operations/release-management.md).

---

## 1. Current-state map

### 1.1 The three cadences (today)

OpenPalm ships on **three independent tracks** (per the knowledge note and `release-management.md` §"The three tracks"):

| Track | What | Versioning | Trigger today |
|---|---|---|---|
| **A — Platform** | lib, CLI, guardian/assistant/portal images, voice images, CLI binaries, Electron, GitHub release | single coordinated version (`platformManifests`) | `v*` tag push **or** `release.yml` `workflow_dispatch` |
| **B — Portal runtime inputs** | baked portal adapters + guardian-hosted API | coordinated with platform | same platform release flow |
| **C — UI** | `@openpalm/ui` | independent | push to `main` touching `packages/ui/**`, **or** `publish-ui.yml` `workflow_dispatch` |

`.github/release-package-groups.json` is the authoritative list:
- `platformManifests`: `package.json`, `packages/lib`, `containers/guardian`, `packages/cli`, `portals/discord`, `portals/slack`, `packages/electron`, `packages/electron/admin-tools`.
- `independentNpmPackages`: `packages/ui`.

Current version drift snapshot (proves the tracks really do drift): all 7 platform manifests + 3 adapters are `0.11.0-rc.6`; `packages/ui` is `0.11.0-rc.17`.

### 1.2 Every release artifact, how it is versioned & triggered, where it can half-publish

| # | Artifact | Published by | Trigger | Registry | Versioned from |
|---|---|---|---|---|---|
| 1 | `@openpalm/lib` (npm) | `release.yml` → `publish-lib-npm` (release.yml:549) | `v*` tag / dispatch | npmjs | `platformManifests` |
| 2 | `openpalm` CLI (npm) | `release.yml` → `publish-cli-npm` (release.yml:609) | `v*` tag / dispatch | npmjs | platform |
| 3 | `openpalm/assistant`, `/guardian`, `/portal` (Docker, amd64+arm64) | `release.yml` → `push-images` matrix (release.yml:203) | `v*` tag / dispatch | Docker Hub | `v<version>` + `latest` (stable only) |
| 4 | `openpalm/voice:{latest,v<v>}-{cpu,cu121}` | **`publish-voice.yml`** (separate) | push `containers/voice/**` / dispatch | Docker Hub | own `version` input |
| 5 | `openpalm/voice-models` | **`publish-voice-models.yml`** (separate) | push `containers/voice/Dockerfile.models` / dispatch | Docker Hub | own `tag` input |
| 7 | CLI binaries ×5 | `release.yml` → `build-cli-artifacts` (release.yml:275) | `v*` tag / dispatch | GitHub assets | platform |
| 8 | Electron installers (mac/linux/win) | `release.yml` → `build-electron-artifacts` (release.yml:328) | `v*` tag / dispatch | GitHub assets | platform |
| 9 | GitHub release + checksums + deploy bundle | `release.yml` → `release` (release.yml:418) | `v*` tag / dispatch | GitHub release | platform |
| 10 | git tag `v<version>` | `release.yml` → `prepare-tag` (release.yml:29) | dispatch creates; push consumes | git | platform |
| 11 | `scripts/setup.sh` / `setup.ps1` `SCRIPT_VERSION` stamps | `prepare-tag` (dispatch) / `release.sh` (manual) | with platform bump | repo file | platform |
| 12 | `@openpalm/ui` (npm) + `ui-v<v>` GitHub release | **`publish-ui.yml`** → `publish-npm-package.yml` | push `packages/ui/**` / dispatch | npmjs + GitHub | independent |

### 1.3 Internal coupling the bump must keep coherent

- **CLI → lib floor range.** `bump-platform.sh` (scripts/bump-platform.sh:53-65) rewrites any `@openpalm/lib` `">=X <N.0.0"` dependency range so the floor tracks lib's version. CI enforces this (ci.yml "Validate platform version sync").
- **Dockerfile ARG pins** that are *not* a release version but must be kept in lockstep by CI, not the release workflow:
  - `OPENCODE_VERSION=1.15.13` in `containers/assistant/Dockerfile:14` **and** `containers/guardian/Dockerfile:18` (ci.yml validates).
  - `AKM_CLI_VERSION=0.8.0` in `containers/assistant/Dockerfile:18` (ci.yml validates; guardian no longer installs akm-cli).
  - `BUN_VERSION` lockstep across assistant/guardian/portal (ci.yml "Validate BUN_VERSION sync").
- **Image tag resolution at runtime.** `config-persistence.ts:27` `DEFAULT_IMAGE_TAG = "latest"`; `stack.env` carries `OP_IMAGE_TAG=latest`. Voice resolves `${OP_VOICE_IMAGE_TAG:-latest-<variant>}` (registry.ts `voiceImageRef`). So Docker images are consumed by **moving `latest` tags**, not by `v<version>` — meaning a stable platform release MUST produce `latest`/`latest-*` tags or fresh installs break (documented as an outstanding 0.11.0 risk in release-management.md:351-357).
- **`PORTAL_PACKAGE`** in `.openpalm/config/stack/portals.compose.yml` selects baked portal adapters in the shared `openpalm/portal` image.

### 1.4 Where the current design risks half-published releases

1. **Platform npm vs Docker ordering can still half-publish.** `push-images` (Docker) runs in parallel with `release`/npm jobs and only `needs: prepare-tag`. For platform packages this is mostly cosmetic (images bundle from source, not npm), but it means a release can show "images pushed, npm failed" with no gate.
2. **Tracks are still split.** A major/minor cut requires the maintainer to run `release.yml` (Track A), separately dispatch `publish-ui.yml` (Track C), and possibly `publish-voice.yml`. Nothing fully enforces they share a version or all succeed.
3. **Auto-triggers on merge-to-main publish unpredictably.** Any push to `main` touching `packages/ui/**` auto-publishes a patch/prerelease bump. During a coordinated release this can still race the orchestrator.
4. **Voice is fully out-of-band.** `push-voice-images` is *commented out* of `release.yml` (release.yml:264-269); voice ships only via `publish-voice.yml`. A platform release never produces matching voice tags unless the maintainer remembers to dispatch it. release-management.md:351-354 flags that `voice:latest-*` has **never existed**.
5. **Partial GitHub release.** Mitigated already: the release job deletes-then-recreates (release.yml:469-480) because `softprops` strips assets on re-cut. Good pattern, but it lives only in Track A.
6. **No global preflight.** Nothing checks "is `v<version>` already on npm / Docker / git" before starting. Individual npm jobs treat "already published" as success (idempotent), but there is no upfront "this version is partially out there, resume vs abort" decision.

---

## 2. Dependency / ordering DAG

### 2.1 Hard ordering constraints

- **C1 — npm before Docker when the release depends on npm artifacts:** still useful so a failed npm publish aborts before immutable image tags are pushed.
- **C2 — `@openpalm/lib` before `openpalm` (CLI) on npm:** the CLI's `publish-cli-npm` already waits for lib to be resolvable on the registry (release.yml:640-664). Enforce in the DAG.
- **C3 — voice-models image before voice images:** `containers/voice/Dockerfile` pulls `voice-models` (publish-voice-models.yml header). So `publish-voice-models.yml` must precede `publish-voice.yml` *when the model pin changed*.
- **C6 — git tag + GitHub release LAST:** the tag is the immutable "this happened" marker; publish it only after npm + Docker succeed, so a failed publish never leaves a tag pointing at an unpublished release. (Today `prepare-tag` creates the tag FIRST on dispatch — see Risk in §4.)

### 2.2 Proposed publish DAG (top = first)

```
prepare (validate version, clean tree, preflight "not already published", run tests)
        │
        ├──────────────► bump + sync ALL manifests + setup stamps + lockfile (commit)
        │
        ▼
  ┌─────────────────────── npm layer (ordered) ───────────────────────┐
  │  @openpalm/lib                                                     │
  │     │                                                              │
  │     ├──► openpalm (CLI)         [C2]                               │
  │  @openpalm/ui  (independent of lib at runtime; can run in parallel)│
  └───────────────────────────────────────────────────────────────────┘
        │ (all npm green)
        ▼
  ┌──────────── Docker + binaries layer (parallel matrices) ──────────┐
  │  push-images: assistant / guardian / portal   [C1]                │
  │  voice-models (only if model pin changed)  ──► voice cpu/cu121 [C3]│
  │  build-cli-artifacts ×5                                            │
  │  build-electron-artifacts ×3 (builds UI for bundle)               │
  └───────────────────────────────────────────────────────────────────┘
        │ (all green)
        ▼
  git tag v<version>  +  GitHub release (assets, checksums)   [C6]
        │
        ▼
  post-publish: verify baked portal adapter selection + latest/latest-* tags,
                update CHANGELOG marker (stable only)
```

Rationale: the npm layer is the only one with intra-dependency edges, so order it strictly. Docker/binary/electron matrices are mutually independent (`fail-fast: false`) and only need "npm is live" as a gate. Tag + GitHub release go last so the immutable marker implies everything before it succeeded.

---

## 3. Proposed architecture

### 3.1 Single orchestrator vs thin orchestrator + reusable children

**Recommendation: a thin orchestrator (`platform-release.yml`) that calls reusable `workflow_call` children — but consolidate the children first.**

Weighing the two:

| | Single mega-workflow | Thin orchestrator + `workflow_call` children |
|---|---|---|
| Resume from step N | Re-run individual *jobs* via the Actions UI (already works for matrices) | Re-run individual *child workflows*; cleaner per-target boundary |
| Reuse for independent (B/C) cadences | Hard — logic is inline | **Reuse the SAME child** for both the coordinated release and the standalone patch dispatch |
| Readability | One 800-line file | Orchestrator stays ~150 lines; each child is single-purpose |
| GitHub constraints | one `concurrency` group | `workflow_call` children inherit caller secrets; fine |

The deciding factor is **C/B reuse**: the project explicitly wants standalone UI / adapter patch releases to keep working. If the publish logic lives in reusable children, the orchestrator calls them in order for a coordinated release, and the standalone dispatch workflows call the **same** child for a one-off. That removes the current duplication where `release.yml` has its own inline `publish-lib-npm`/`publish-cli-npm`/`publish-channels-sdk-npm` jobs (release.yml:549-754) that are near-copies of `publish-npm-package.yml`.

**Concrete child set:**
- `publish-npm-package.yml` — already reusable; keep. Make it the single npm publisher for **all** npm packages (lib, CLI, channels-sdk, ui, the 3 adapters). It already supports `version`, `needs-build`, idempotent "already published". Add an optional `wait-for` input (a `name@version` to poll on the registry before publishing) to express C2/C3 inside the child.
- `build-push-image.yml` (new, `workflow_call`) — parameterized by `image`, `dockerfile`, `context`, `platforms`, `build-args`, `prerelease`. Used by assistant/guardian/channel **and** voice/voice-models, replacing the bespoke matrices.
- `build-cli.yml`, `build-electron.yml` (new, `workflow_call`) — wrap the existing matrices.
- `github-release.yml` (new, `workflow_call`) — the deferred tag-create + delete-then-recreate release.

The orchestrator `platform-release.yml` wires these together in the §2.2 DAG using `needs:`.

### 3.2 How the version is supplied + propagated

- **Single input:** `workflow_dispatch.inputs.version` (semver, required for a real run; keep the existing `dry_run` boolean). Optional `mode` (`major|minor|patch`) is unnecessary — the maintainer supplies the literal version, matching today's `release.yml` behavior (release.yml:8-12, 80-97).
- **Propagation in one `prepare` job:**
  1. Validate semver + derive `prerelease` (has `-`) exactly as release.yml:85-102.
  2. Run `bump-platform.sh <version>` (stamps the 7 platform manifests + CLI lib floor).
  3. For a **major/minor** coordinated cut, ALSO stamp the independents to the **same** version: `packages/ui`, `packages/channel-{api,discord,slack}`. Add these paths to a new `coordinatedManifests` list in `release-package-groups.json` (keeps `independentNpmPackages` for the standalone path). Use a single `set_version` helper (the one already duplicated in publish-ui.yml:80-87 / publish-npm-package.yml:58-65 — extract to `scripts/set-version.mjs`).
  4. Stamp `setup.sh` / `setup.ps1` (release.yml:136-137).
  5. `bun install` to regenerate `bun.lock` (release.yml:143).
  6. Commit `chore: release <version>` on the dispatch branch.
- **Patch / independent releases still work** because the standalone `publish-ui.yml` / `publish-channel-*.yml` keep their own dispatch + the reusable child. They just no longer auto-fire on push (see §3.4). A maintainer fixing a Discord typo dispatches `publish-channel-discord.yml` with `patch` — unchanged semantics.

### 3.3 The `workflow_dispatch`-from-`main`-only constraint

GitHub only lets you dispatch a workflow whose definition exists on the **default branch (`main`)**, and `gh workflow run platform-release.yml --ref release/0.11.0` runs **`main`'s copy of the file against the `release/...` ref's checkout** only if the file also exists on main. Releases are cut from `release/<x>` branches (release-management.md:134, "scripts/release.sh hardcodes main").

**Recommended strategy:** keep `platform-release.yml` on `main` permanently, and add a required `ref` input:

```yaml
workflow_dispatch:
  inputs:
    version: { required: true,  type: string }
    ref:     { required: true,  type: string, default: main,
               description: 'Branch/tag to release from (e.g. release/0.11.0)' }
    dry_run: { type: boolean, default: false }
```

The `prepare` job does `actions/checkout@v6` with `ref: ${{ inputs.ref }}`, then bumps/commits/tags **on that ref**. Because the *workflow file itself* is always taken from `main` (GitHub's dispatch rule), changes to the release workflow must be merged to `main` before they take effect — which is desirable (the release machinery is reviewed on main, the release *content* comes from the branch). This is exactly how today's `release.yml` already copes: it `git checkout "${GITHUB_REF_NAME}"` inside `prepare-tag` (release.yml:124-128) — but `GITHUB_REF_NAME` is the dispatch ref, which for a `main`-only-dispatchable workflow is `main`. The explicit `ref` input makes the intended branch unambiguous instead of relying on dispatching "from" a branch (which GitHub disallows for non-main files anyway).

> Document loudly: "To release from `release/X`, the `platform-release.yml` on `main` must already contain the workflow you want; supply `ref=release/X`." This removes the current footgun where a maintainer expects `--ref release/X` to use that branch's *workflow file*.

### 3.4 Keep or drop the merge-to-main auto-triggers?

**Recommendation: DROP the `push:` auto-triggers; keep `workflow_dispatch` on the standalone publishers.**

- Remove the `push: branches:[main] paths:[...]` blocks from `publish-ui.yml:10-12`, `publish-channel-{api,discord,slack}.yml:3-5`, and (optionally) `publish-voice.yml:21-23` / `publish-voice-models.yml:20-22`.
- Rationale: auto-publish-on-merge causes the exact "uncoordinated version published mid-release" race (§1.4 #3), and an accidental publish is irreversible on npm. Explicit dispatch makes every publish intentional. The standalone `workflow_dispatch` paths remain for genuine independent patch releases.
- Trade-off the maintainer should confirm: today a docs/typo fix to an adapter auto-ships on merge. After this change, the maintainer must dispatch it. For a small team this is the right call (predictability > convenience), and it is the project's stated direction (goal #4).

---

## 4. Fail-safe + recovery design

### 4.1 Preflight (in `prepare`, before any mutation)

1. **Clean tree / valid ref** — `git status --porcelain` empty after checkout of `inputs.ref` (mirrors release.sh:27-30).
2. **Version not fully published already** — for each npm package, `npm view <name>@<version>`; for Docker, `docker manifest inspect <img>:v<version>`; for git, `git rev-parse v<version>`. Classify each target as `MISSING` / `PRESENT`. If **all** present → "already released, nothing to do" (clean exit). If **some** present → emit a `::warning::` table and proceed in **resume mode** (publish only `MISSING`). This is the partial-state detector.
3. **Tag-move guard** — if `v<version>` exists but does not point at the release HEAD, **fail** (release.yml:190-198 already does this; keep).
4. **Tests green** — run `bun run test` + `bun run ui:check` once in `prepare` (gates the whole release, like release.sh:70-72). Do **not** re-run per child.
5. **Dist-tag sanity** — for a stable cut, assert no platform manifest carries a `-` suffix; for a prerelease, assert all do.

### 4.2 Per-target idempotency (already mostly present — formalize)

| Target | Idempotency mechanism |
|---|---|
| npm (all packages) | `npm publish ... || (npm view <pkg>@<v> && warn-skip)` — exists in publish-npm-package.yml:153-161 and the inline release.yml jobs. Keep in the single child. |
| Docker images | Pushing the same `v<version>` tag re-pushes identical layers (content-addressed) — safe to re-run. Add a pre-check `docker manifest inspect` to short-circuit. |
| CLI / Electron artifacts | Pure build → upload-artifact; re-run overwrites. Safe. |
| git tag | "skip if at HEAD, refuse to move" (release.yml:190-198). Keep. |
| GitHub release | delete-then-recreate (release.yml:469-480). Keep. |

### 4.3 "Resume from step N"

- **Native mechanism:** GitHub's **"Re-run failed jobs"** on the orchestrator run. Because each child is a separate job with `needs:` edges, re-running failed jobs re-executes only the broken leg and its downstream. Combined with per-target idempotency (§4.2), a re-run is safe even for jobs that *partly* succeeded.
- **Cross-run resume:** because `prepare` writes the bump commit + (eventually) the tag, re-dispatching the **same** `version` against the **same** `ref` enters resume mode (§4.1 #2) and skips already-published targets. So both "re-run failed jobs" (same run) and "re-dispatch" (new run) converge.
- **Fail-fast per matrix leg:** keep `fail-fast: false` on Docker/CLI/Electron/voice matrices (already set, release.yml:213/284/337, publish-voice.yml:45) so one flaky leg never cancels siblings.

### 4.4 Tag-LAST ordering (the one real change vs today)

Today `prepare-tag` creates and pushes the tag **before** any publish (release.yml:177-201). Move tag creation + GitHub release into the final `github-release` job (`needs:` all npm + all Docker + binaries). Effect: a failed npm/Docker publish leaves **no tag** and **no GitHub release**, so "is this version released?" has a single source of truth (the tag's existence ⇒ everything succeeded). The bump *commit* is still pushed early (needed so child checkouts see synchronized versions) — that is cheap to reconcile if a release aborts (it is just a chore commit).

### 4.5 Per-target manual recovery recipes (document in `release-management.md`)

- **npm package failed to publish:** dispatch `publish-npm-package.yml` (via the package's standalone workflow) with the exact `version` — idempotent, re-resolves deps. Or locally: `cd <pkg> && bun pm pack && npm publish <tgz> --provenance --access public [--tag next]`.
- **npm published but unpublishable mistake:** npm forbids re-publishing a version; bump to the next patch/prerelease and re-run. (Document: never `npm unpublish` a >24h-old version.)
- **Docker image leg failed:** re-run that matrix leg, or locally `docker buildx build --push -t openpalm/<img>:v<version> -f <dockerfile> --platform linux/amd64,linux/arm64 .` (add `latest` for stable).
- **Voice missing:** dispatch `publish-voice.yml` with `version=<v>` (and `publish-voice-models.yml` first if the model pin changed).
- **CLI / Electron asset missing from GitHub release:** re-run `build-*-artifacts` + `github-release` (delete-then-recreate handles asset replacement).
- **Tag points at wrong commit:** `git push origin :refs/tags/v<version>` to delete, fix, re-dispatch (the move-guard refuses to silently move it).
- **`PORTAL_PACKAGE` still `@next` after stable:** edit the 4 lines in `.openpalm/config/stack/portals.compose.yml` and ship a patch (post-publish step §2.2 automates the verify).

---

## 5. Version-sync mechanism

### 5.1 Coordinated major/minor (the master workflow's job)

1. Add `coordinatedManifests` to `.github/release-package-groups.json` = `platformManifests` **+** the 4 `independentNpmPackages`. (Keep both keys: `platformManifests` for the platform-only floor-range logic, `independentNpmPackages` for the standalone path.)
2. Extract the duplicated `set_version`/`bump_version` JS (in publish-ui.yml:80-115, publish-npm-package.yml:58-95, bump-platform.sh:53-65) into one `scripts/set-version.mjs <file> <version>` that also rewrites the `@openpalm/lib` floor range. Single source of truth, no shell-embedded node heredocs.
3. `prepare` runs `set-version.mjs` over `coordinatedManifests`, stamps setup scripts, `bun install`, commits. After this commit **every** shipped piece carries the **same** `<version>` — the "one coherent version" goal.
4. CI's existing "Validate platform version sync" (ci.yml:199-232) is extended to also assert the independents match when on a release branch (or simply that the orchestrator's committed state is internally consistent).

### 5.2 Image tags

Image tags are **derived**, not stored in a manifest: `metadata-action` emits `v<version>` always and `latest` only for stable (release.yml:248-250). No separate bump needed — the orchestrator passes `version` + `prerelease` to the image children. The only stored image-tag value is `OP_IMAGE_TAG=latest` in generated `stack.env` (config-persistence.ts:130), which is intentionally a moving tag and does **not** change per release.

### 5.3 Dockerfile ARG pins (OPENCODE/AKM/BUN) are deliberately OUT of scope

These track upstream tool versions, not the OpenPalm release version. They are bumped by hand and **validated** by CI (ci.yml lockstep checks). The release workflow must **not** touch them — surface them in the release checklist only.

### 5.4 Patch & independent releases still work

- **Platform patch (e.g. 0.11.1):** same orchestrator, supply `version=0.11.1`; it bumps everything coordinated. If the maintainer wants a platform-only patch *without* re-versioning UI/adapters, provide an orchestrator boolean `coordinate_independents` (default `true` for major/minor; the maintainer sets `false` to bump only `platformManifests`).
- **Independent patch (UI or one adapter):** dispatch the standalone workflow → reusable child, exactly as today. Untouched by the orchestrator.

---

## 6. Migration plan (low-risk, ordered increments)

Each step is independently shippable and reversible.

1. **Extract shared scripts (no behavior change).** Create `scripts/set-version.mjs`; refactor `bump-platform.sh`, `publish-ui.yml`, `publish-npm-package.yml` to call it. Add `coordinatedManifests` to `release-package-groups.json`. Land on `main`. (Pure refactor; CI green proves equivalence.)
2. **Consolidate npm publishing.** Replace the three inline `publish-*-npm` jobs in `release.yml` (release.yml:549-754) with calls to `publish-npm-package.yml` (add the `wait-for` input for C2/C3). Verify with a `dry_run` dispatch. Keeps Track A behavior; removes duplication.
3. **Add reusable image/cli/electron/github-release children** (`workflow_call`) wrapping today's matrices verbatim. Switch `release.yml` to call them. `dry_run` validate.
4. **Introduce `platform-release.yml` orchestrator** that calls the children in the §2.2 DAG, with `ref` + `version` + `dry_run` + `coordinate_independents` inputs and the §4.1 preflight + §4.4 tag-last ordering. Land on `main`. **Test with `dry_run=true` against `release/0.11.0`.**
5. **Fold voice into the orchestrator** as a gated (`fail-fast:false`, additive) child so a coordinated stable cut produces `voice:latest-*` (closes release-management.md:351-354). Keep `publish-voice.yml` for out-of-band model-only rebuilds.
6. **Drop the merge-to-main auto-triggers** (`push:` blocks) from the standalone publishers, leaving `workflow_dispatch`. Announce to the team.
7. **Retire `release.yml`** once `platform-release.yml` has cut one real release successfully (keep the file one cycle as a fallback, then delete).
8. **Update `docs/operations/release-management.md`** to describe the single orchestrator + the per-target recovery recipes (§4.5), and the new `ref`-from-main dispatch rule.

A first **real** use should be a prerelease (`0.11.0-rc.N`) so any rough edges surface under `next`/no-`latest` semantics before a stable cut.

---

## 7. Risks / open questions for the maintainer

1. **Tag-last vs tag-first.** Moving tag creation to the end (§4.4) is the one semantic change from today. Confirm you want "tag exists ⇒ fully published" (recommended) vs today's "tag triggers the build". The orchestrator model makes tag-first unnecessary.
2. **`coordinate_independents` default.** Should a major/minor **always** re-version UI + adapters to the platform version (my recommendation), or only when explicitly requested? Re-versioning the UI from its current independent `0.11.0-rc.17` down/across to `0.11.0` is a version *regression* on npm — npm will reject publishing a lower version. **Open question:** for the first coordinated cut, the UI/adapter versions must be ≥ their last published version. The orchestrator should `max(supplied, current-on-npm)` per independent package, or refuse with a clear error. Decide the policy.
3. **Dropping auto-publish-on-merge** changes adapter/UI patch ergonomics (must dispatch now). Confirm acceptable.
4. **Dispatch-from-main reality.** Everyone must internalize that the *workflow file* always comes from `main`; only the *content* comes from `ref`. Acceptable, but it means release-workflow edits need a merge to `main` before they can be used to cut a `release/X` build.
5. **Voice cost in the coordinated path.** Voice images take ~90 min (publish-voice.yml:42). Even as a non-blocking child, a coordinated stable cut becomes long. Keep voice gated to **stable** cuts only? (Prereleases skip it.)
6. **Electron `--publish never` + central upload** (release.yml:394-403) must be preserved in the extracted child; electron-builder's own publisher 401s on re-cut.
7. **OIDC trusted publishing** requires `id-token: write` on every npm child (already set). Confirm npm's trusted-publisher config lists the new orchestrator/child workflow filenames, or publishes will 403.

---

## Executive summary

OpenPalm ships three uncoordinated release tracks today — Platform (`release.yml`, `v*` tag), independently-versioned channel adapters, and the UI — each with its own trigger, and several artifacts (voice images, voice-models) live entirely outside the platform pipeline. A coordinated major/minor therefore requires the maintainer to manually orchestrate `release.yml` plus separate dispatches of `publish-ui.yml`, three `publish-channel-*.yml`, and `publish-voice.yml`, with nothing enforcing a shared version or all-or-nothing success — the documented 0.11.0 cutover checklist is exactly this manual, half-publishable list.

I propose a single **`platform-release.yml`** orchestrator (manual `workflow_dispatch` with `version`, `ref`, `dry_run`, `coordinate_independents`) that lives on `main` (GitHub's dispatch-from-default-branch constraint) and releases the supplied `ref` branch. It is a **thin orchestrator calling reusable `workflow_call` children** (the existing `publish-npm-package.yml` for all six npm packages, plus new `build-push-image` / `build-cli` / `build-electron` / `github-release` children), chosen over a mega-workflow specifically so the standalone independent-patch dispatches reuse the same children. It bumps every shipped manifest to one coherent version via a single extracted `scripts/set-version.mjs` + a new `coordinatedManifests` list, then publishes in a strict DAG: lib → CLI/channels-sdk → adapters, UI in parallel; then Docker/voice/CLI/Electron once npm is green; then git tag + GitHub release **last** so "tag exists ⇒ fully published." Fail-safety comes from an upfront preflight (clean tree, tests green, per-target "already published?" partial-state detection → resume mode), per-target idempotency (already largely present), GitHub "re-run failed jobs," and documented per-target manual recovery. I recommend **dropping the merge-to-main auto-publish triggers** in favor of explicit dispatch. Migration is eight low-risk increments (script extraction → consolidate npm jobs → extract image/cli/electron children → introduce orchestrator → fold in voice → drop auto-triggers → retire `release.yml` → docs), each `dry_run`-validatable, first exercised on a prerelease. Key open questions: tag-last semantics, the independent-version-regression problem (UI is already at `rc.17` vs platform `rc.6` → must `max()` or refuse), and whether voice runs on every coordinated cut.

**Proposal doc:** `/home/founder3/code/github/itlackey/openpalm/docs/technical/master-release-workflow-proposal.md`
