# Embedded assets

`ui-build.tar.gz` and `skeleton.tar.gz` in this directory are what `bun build
--compile` embeds into the CLI binary (see `../src/lib/embedded-assets.ts`).

The two files checked into git are **placeholders** — an empty tar.gz holding
only a `.placeholder` marker. `../scripts/pack-embedded-assets.ts` overwrites
them with the real `packages/ui/build` and `packages/skeleton` contents right
before each `build:*` script compiles a release binary (see
`.github/workflows/release.yml`'s `cli:` job). Never commit the real, packed
archives — they're regenerated on every release build and can be large.

Runtime code treats a placeholder (no `index.js` / no `system/` after
extraction) as "nothing embedded" and falls back to local resolution (a repo
checkout or `OPENPALM_REPO_ROOT`/`OPENPALM_SKELETON_DIR`), so a source
checkout and `bun test` work with the placeholders in place.

That fallback finds nothing on a user's machine, so a release binary must
never embed a placeholder. `pack-embedded-assets.ts` fails the build if a
source directory is missing rather than leaving one in place.
