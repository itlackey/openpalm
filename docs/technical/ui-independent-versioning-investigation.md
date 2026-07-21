# Independently Versioning the SvelteKit UI from the Electron Harness

> HISTORICAL: shipped in 0.12.0; kept as a design record. Current behavior is
> authoritative in [`release-architecture.md`](./release-architecture.md) (the
> `platform` vs `electron` release units) and
> [`architecture.md`](./architecture.md) for the post-One-UI app model.

**Date:** 2026-06-04
**Question:** (1) How can the SvelteKit UI carry its own version line, decoupled from the Electron app/platform version? (2) Is distributing the UI build as an **npm package** a good pattern?

Companion to [`ui-distribution-gap-analysis.md`](./ui-distribution-gap-analysis.md). This answers the "G5 (single shared tag)" follow-up.

---

## Implementation status (2026-06-04)

**Shipped — `@openpalm/ui` is now independently versioned from the platform package manifests.**

Distribution core:
- `@openpalm/ui` is a **publishable, zero-runtime-dependency** npm package. `private:true` removed; `files:["build"]`; the four runtime deps (`@openpalm/lib`, `croner`, `markdown-it`, `yaml`) moved to `devDependencies` because the `adapter-node` build bundles them — the published artifact is `build/` only and needs no `node_modules` at runtime. Eliminates the `workspace:*`-in-published-deps problem with no CI dep-pinning (the "restructure workspace deps for simplicity" ask).
- **`ui-assets.ts`** `seedUiBuild` + `checkAndUpdateUiBuild` source the bundle from the **npm registry tarball** (`registry.npmjs.org/@openpalm/ui/<version-or-dist-tag>`): dist-tag channel chosen from the app's release stream (`next` for prereleases — fixes the `releases/latest`-excludes-prereleases blind spot), **integrity-verified fail-closed** against `dist.integrity` (closes gap **G2**), `package/build/**` extracted with `strip:2` + path filter. Verified empirically against a real `bun pm pack` tarball (327 files, `index.js` + stamp at `data/ui/` root, no leakage).

Independent versioning + publishing:
- **`release-package-groups.json`**: `packages/ui/package.json` removed from `platformManifests` and `packages/ui` added to `independentNpmPackages`. So `bump-platform.sh` no longer touches the UI version and the CI "platform version sync" check no longer requires it to match root — the UI version **floats**.
- **`.github/workflows/release.yml`** is now the single trusted-publisher entry point. The UI is published through its `ui` unit rather than a standalone `publish-ui.yml` workflow.
- The platform release workflow still builds the UI for the Electron bundle and other host artifacts as needed.
- **The updater now compares against the on-disk UI stamp, not the app version.** Because the UI floats, `checkAndUpdateUiBuild(appVersion, …)` uses `appVersion` only to pick the dist-tag CHANNEL, then compares the newest UI on that channel against `readUiBuildVersion(resolveUiBuildDir())` — the version actually running. The first-seed callers (electron fallback, CLI install) seed by `uiUpdateChannel(version)` (`latest`/`next`) instead of the platform version, which is no longer a valid `@openpalm/ui` version.

**Compatibility posture:** the UI bundles `@openpalm/lib` at build time and has no enforced compatibility gate. The one real skew surface is the Electron preload IPC contract (`window.openpalm` = `updateStatus`/`notify`/`restart`) — currently minimal and stable. **Watch-item:** if that preload contract grows a breaking change, add a `requires.shell` gate to `checkAndUpdateUiBuild` (the original G3). Not needed today.

**Still deferred (separate reliability gaps, out of scope):** health-gated rollback + staging/atomic promote (G1/G7), tracked in `ui-distribution-gap-analysis.md`.

## TL;DR recommendation

**Yes — publish the UI as `@openpalm/ui` on npm and let it float its own semver.** The Electron updater should fetch the npm *registry tarball* over plain HTTPS and verify the registry integrity hash — it should NOT shell out to a package manager at launch. The CLI host path (`openpalm ui serve`), which already runs under Bun, can use real `bun add @openpalm/ui`.

This is a net win because npm gives us, for free, four things we currently hand-roll or lack:
1. **An independent version line + channels** via dist-tags (`latest`/`next`) — the same mechanism already handled by the current npm publish workflow.
2. **Fail-closed integrity** — the registry publishes a `sha512` for every tarball; `bun add`/a tarball fetch verify it automatically. (Closes gap **G2**.)
3. **Immutable versions** — you cannot overwrite a published `@openpalm/ui@1.4.3`. This sidesteps the "softprops strips assets on re-cut" GitHub-release fragility entirely.
4. **Clean prerelease separation** — `@next` vs `@latest` dist-tags. This is the *exact* bug that bit rc.2: `releases/latest` excludes prereleases, so a prerelease app's UI updater silently never updated. dist-tags make "what's the newest UI on my channel" a first-class query.

**The mandatory companion change:** an independent UI version creates a real compatibility surface, so this MUST ship with a small compatibility manifest (see §4). Decoupling the version without it would let a floating UI outrun the shell/platform it bundles logic for.

---

## 1. What "independent versioning" actually requires

Today the UI version is bumped **in lockstep** with the platform by `scripts/bump-platform.sh`, and the UI updater (`checkAndUpdateUiBuild`) keys off the **platform** `releases/latest` tag compared to the **Electron app** version. Two couplings to break:

1. **Version source.** `packages/ui/package.json` already has its own `version` field and its own `.openpalm-ui-version` stamp (`stamp-version.mjs`) — the machinery exists. We just need to keep it out of `platformManifests` so `bump-platform.sh` does not rewrite it in lockstep.
2. **Update channel.** The updater must compare *UI version ↔ newest UI version on a UI-specific channel*, not *app version ↔ platform release tag*. npm dist-tags are that channel.

Note this is genuinely the right component to single out: the UI is the **only** artifact that is (a) consumed by *both* the desktop shell and the CLI host install, (b) has a legitimate reason to ship fixes faster than the Docker image stack (client bugs, CSS, copy), and (c) already owns a dedicated auto-updater. The guardian/assistant/portal **images** stay lockstep on the platform tag (they share the `OP_IMAGE_TAG` contract); only the UI floats.

## 2. Why npm specifically (and the precedent already in-repo)

We do **not** need to invent this. The repo already has the core mechanisms needed:

- `bump-platform.sh` excludes `packages/ui` from the coordinated platform manifest bump set.
- Portal adapters are baked into `containers/portal`, while the OpenAI-compatible API runs from `containers/guardian`.
- `release.yml` already publishes npm artifacts with `--provenance` and prerelease-aware dist-tags.

So `@openpalm/ui` would be a **fourth instance of an existing, proven job** — not new infrastructure. Consistency with the adapter model is itself a strong argument: one mental model ("runtime-swappable components are dist-tagged npm packages") instead of two.

### npm vs. the alternatives

| Transport | Independent version | Free integrity | Immutable versions | Clean prerelease channel | New infra |
|---|---|---|---|---|---|
| **npm package (`@openpalm/ui`)** | ✅ semver | ✅ registry sha512 | ✅ | ✅ dist-tags | reuse existing publish job |
| Separate GitHub tag `ui-v*` | ✅ | ❌ (hand-roll checksums) | ❌ (re-cut strips assets) | ❌ (`releases/latest` excludes prereleases — the rc.2 bug) | new tag scheme + filter logic |
| Status quo (single platform tag) | ❌ | best-effort checksum | ❌ | ❌ | none |

npm dominates the GitHub-asset approach on every axis that actually bit us.

## 3. Recommended distribution design (hybrid: npm registry, package-manager-free desktop fetch)

The one trap to avoid: **do not run `bun add`/`npm i` inside the Electron app at launch.** It works for portals because the portal *container* ships Bun; the desktop AppImage/dmg does not guarantee a package manager, and shelling out to one at startup is fragile (offline, corporate proxies, registry auth, PATH). Instead, treat npm as a **versioned artifact registry with an HTTPS tarball API**:

- **Resolve the channel:** `GET https://registry.npmjs.org/@openpalm/ui` → read `dist-tags.latest` (or `.next` for prerelease builds). This replaces the `releases/latest` call and is prerelease-aware.
- **Get the tarball + integrity:** from the version's `dist.tarball` (`https://registry.npmjs.org/@openpalm/ui/-/ui-<version>.tgz`) and `dist.integrity` (sha512).
- **Download + verify:** plain `fetch` the `.tgz`, verify sha512 against `dist.integrity` (**fail closed** — this is the privileged-code path). Closes G2.
- **Extract:** npm tarballs nest everything under `package/`, so extract with `strip: 1` into `data/ui.staging`, validate `index.js`, then atomic-rename over `data/ui` (also closes G7).

`seedUiBuild`/`checkAndUpdateUiBuild` in `packages/lib/src/control-plane/ui-assets.ts` change from "GitHub release asset" to "npm registry tarball." Everything downstream (`resolveUiBuildDir` version-stamp arbitration, the bundled-vs-`data/ui` model) stays identical — we're only swapping the *source* of the tarball and the *channel* query.

For the **CLI host path** (already Bun): `bun add @openpalm/ui@<channel>` is fine and even more consistent with the adapter story. Both paths converge on the same npm version line.

The **Electron build-time bundle** (`extraResources: ui-build`) keeps working unchanged — but instead of "whatever `packages/ui/build` happens to be," CI pins the specific `@openpalm/ui` version the shell was built/tested against, which feeds the compatibility manifest below.

## 4. The mandatory companion: a compatibility manifest (do NOT skip)

An independent UI version is only safe if it declares what it needs. **The UI server is not a thin renderer** — per `core-principles.md` it is a privileged control-plane host. Concretely it couples to three things:

1. **`@openpalm/lib` (bundled in).** `adapter-node` Rollup-bundles a *specific* lib version into the UI. That bundled lib writes compose files / reads `OP_HOME` / drives Docker. A UI that floats ahead could bundle a newer lib that emits a compose format the installed **platform images** don't understand. → UI must declare a compatible **platform** floor.
2. **The Electron preload IPC bridge.** Today minimal (`restart-app`, env vars), but the moment a real `window.desktop.*` contract exists, a floating UI could call a method an older **shell** lacks. → UI must declare a compatible **shellVersion**.
3. **Node runtime** shipped/спawned by the shell. → declare `node >=`.

`@openpalm/ui`'s `package.json` is the natural home (no separate manifest asset needed — npm already serves it):

```jsonc
{
  "name": "@openpalm/ui",
  "version": "1.4.3",
  "openpalm": {
    "requires": { "shell": ">=0.11.0 <0.12.0", "platform": ">=0.11.0", "node": ">=20" }
  }
}
```

`checkAndUpdateUiBuild` refuses any candidate whose `requires` the current shell/platform doesn't satisfy, and falls back to the bundled build. This is gap **G3** from the companion doc — independent versioning is the forcing function that makes it non-optional.

## 5. Risks / costs (honest accounting)

- **npm publishes are immutable + irreversible.** A bad `@openpalm/ui@1.4.3` can't be fixed in place — you bump to `1.4.4` and roll the `latest` dist-tag back (`npm dist-tag add @openpalm/ui@1.4.2 latest`) + `npm deprecate` the bad one. This is *better* than today (where a GitHub re-cut silently strips assets), but the team must know the dist-tag-rollback runbook.
- **Compiled-output package.** `@openpalm/ui` ships `build/` (adapter-node output), not source. Acceptable (common for dist-shipping packages); set `files: ["build"]` and drop `private: true`.
- **Two version lines to reason about.** Platform tag (images/CLI/shell) + UI semver. Mitigated by the precedent (adapters already do this) and the compatibility manifest making skew explicit rather than silent.
- **Provenance/auth in CI.** Reuse the existing `--provenance --access public` publish job; `@openpalm/ui` must be public scoped (it already is `@openpalm`-scoped). One more job, ~copy-paste of the lib job.
- **Desktop fetch must stay package-manager-free** (see §3) — if someone "simplifies" it to `bun add` at launch, it breaks offline/locked-down desktops. Document this as a load-bearing constraint.

## 6. Migration steps (incremental, low-risk)

1. Drop `private: true` on `packages/ui/package.json`; add `files: ["build"]` and the `openpalm.requires` block. Add a `prepack`/`pack` that ensures `build/` + the `.openpalm-ui-version` stamp are present.
2. Remove `packages/ui` from `bump-platform.sh`'s lockstep set (mirror the `channel-*` exclusion); give it its own bump path.
3. Add a "Publish @openpalm/ui to npm" job in `release.yml` (clone the lib job; `--tag next` for prereleases).
4. Repoint `seedUiBuild`/`checkAndUpdateUiBuild` from GitHub release assets → npm registry tarball + `dist-tags` + `dist.integrity` (fail-closed). Keep the version-stamp arbitration in `resolveUiBuildDir` as-is.
5. Add the `requires` compatibility gate to `checkAndUpdateUiBuild` (G3).
6. (Optional) keep publishing `ui-build.tar.gz` to the GitHub release for the documented out-of-band `curl` recipe, but make npm the primary/source of truth.
7. Fold in staging-dir + atomic rename + rollback-on-health-fail (G1/G7) while touching this code — it's the same function.

## 7. Verdict

- **Independent UI versioning: recommended and low-cost** — the version field, stamp, and "independently-versioned package" precedent already exist; the work is mostly removing a lockstep coupling and repointing the updater.
- **npm as the distribution transport: recommended** — it's the same proven pattern as portal adapters, and it directly closes three of the gap-analysis findings (G2 integrity, the prerelease-channel bug behind G3/rc.2, and the GitHub re-cut asset fragility) at near-zero new infrastructure. The only firm constraints: **fetch the registry tarball over HTTPS rather than running a package manager in the desktop app**, and **ship the compatibility manifest with it** — because OpenPalm's UI server bundles control-plane logic and is therefore not a free-floating renderer.
