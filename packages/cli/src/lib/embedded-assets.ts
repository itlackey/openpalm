/**
 * Embedded UI build + skeleton.
 *
 * A compiled CLI binary (`bun build --compile`) has no filesystem tree next
 * to it to ship a UI build in — unlike containers (baked into the image at
 * `docker build`) and Electron (`extraResources`), the binary IS the whole
 * artifact. So the release build packs `packages/ui/build` and
 * `packages/skeleton` into deterministic tar.gz archives under
 * packages/cli/embedded/ (see scripts/pack-embedded-assets.ts, run before
 * every `build:*` script) and this module embeds them via Bun's
 * compiled-binary file-asset support: a `with { type: 'file' }` import
 * resolves, INSIDE a --compile binary, to a `/$bunfs/...` virtual path that
 * only `Bun.file` can read — not node:fs, and not the `tar`
 * package's own file-based extractor (both throw ENOENT against a bunfs
 * path). So materialization always: (1) reads the embedded bytes via
 * `Bun.file(...).arrayBuffer()`, (2) writes them to a REAL temp file, (3) lets
 * `tar` extract that real file into a REAL temp directory, then (4) renames
 * the temp directory into place — a half-written destination is never
 * observable.
 *
 * The archives are generated, never committed: packages/cli/embedded/ is
 * gitignored and populated by the pack step. They are therefore ABSENT in a
 * source checkout, which is why the imports below are dynamic. A dynamic
 * `import(...)` of a missing asset rejects (catchable) instead of failing the
 * module load, and `bun build --compile` accepts the missing specifier — so a
 * fresh clone runs and tests with no generated files and no placeholder
 * stand-ins. "Nothing embedded" then falls back to local resolution (repo
 * checkout / OPENPALM_REPO_ROOT / Electron resourcesPath) via @openpalm/lib's
 * resolveUiBuildDir / resolveLocalOpenpalmDir.
 *
 * That fallback finds nothing on a user's machine, so a release binary must
 * never be compiled without the archives: scripts/pack-embedded-assets.ts
 * fails the build if its sources are missing, and every `build:*` script runs
 * it first.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x as extractTar } from 'tar';
import { PLATFORM_VERSION, readUiBuildVersion } from '@openpalm/lib';

/**
 * Resolve an embedded archive's path, or null when it was not compiled in.
 * Both specifiers are static string literals so the bundler can still see and
 * embed them; only the *evaluation* is deferred.
 */
async function embeddedArchivePath(kind: 'ui' | 'skeleton'): Promise<string | null> {
  try {
    const module = kind === 'ui'
      ? await import('../../embedded/ui-build.tar.gz', { with: { type: 'file' } })
      : await import('../../embedded/skeleton.tar.gz', { with: { type: 'file' } });
    return module.default;
  } catch {
    return null;
  }
}

/**
 * Extract an embedded (possibly `/$bunfs/`) archive into a fresh real
 * directory under `parentDir` (created if needed). Returns null on any
 * failure — an absent or unreadable archive is "nothing embedded", not an
 * error the caller should surface.
 */
async function extractEmbeddedArchive(archivePath: string, parentDir: string, label: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
  } catch {
    return null;
  }
  mkdirSync(parentDir, { recursive: true });
  const destination = mkdtempSync(join(parentDir, `.${label}-embedded-`));
  // The raw archive bytes only need a REAL path for `tar` to read from; it is
  // written+removed here and never renamed, so it doesn't need to share a
  // filesystem with `destination`.
  const tmpArchive = join(tmpdir(), `openpalm-embedded-${label}-${process.pid}-${Date.now()}.tar.gz`);
  try {
    writeFileSync(tmpArchive, bytes);
    await extractTar({ file: tmpArchive, cwd: destination, strict: true });
    return destination;
  } catch {
    rmSync(destination, { recursive: true, force: true });
    return null;
  } finally {
    rmSync(tmpArchive, { force: true });
  }
}

/**
 * Materialize the embedded UI build into `${dataDir}/ui` when the stamp
 * there does not already match this binary's PLATFORM_VERSION. No backup, no
 * rollback, no channel logic: the embedded copy wins unconditionally the
 * moment the stamp differs. No-ops (returns false) when the stamp already
 * matches, or when no UI build was compiled in.
 *
 * Extracts to a temp directory that is a SIBLING of `${dataDir}/ui` (so the
 * final rename is same-filesystem and atomic) before swapping it in, so a
 * half-written data/ui is never observable.
 *
 * `archivePath` defaults to the embedded UI build and is only overridden by
 * tests, which point it at a fixture archive on real disk (the embedded
 * archive is absent in a source checkout).
 */
export async function materializeEmbeddedUi(
  dataDir: string,
  archivePath?: string,
): Promise<boolean> {
  const uiDir = join(dataDir, 'ui');
  if (readUiBuildVersion(uiDir) === PLATFORM_VERSION) return false;
  const source = archivePath ?? (await embeddedArchivePath('ui'));
  if (!source) return false;
  const extracted = await extractEmbeddedArchive(source, dataDir, 'ui');
  if (!extracted) return false;
  if (!existsSync(join(extracted, 'index.js'))) {
    rmSync(extracted, { recursive: true, force: true });
    return false;
  }
  rmSync(uiDir, { recursive: true, force: true });
  renameSync(extracted, uiDir);
  return true;
}

/**
 * Materialize the embedded skeleton into a fresh temp directory and return
 * its path, or null when no skeleton was compiled in (the caller falls back
 * to @openpalm/lib's resolveLocalOpenpalmDir — a repo checkout or
 * OPENPALM_SKELETON_DIR/OPENPALM_REPO_ROOT override). The returned directory
 * is a plain scratch dir the caller owns: point OPENPALM_SKELETON_DIR at it,
 * call applyHomeSeed, then rmSync it.
 *
 * `archivePath` defaults to the embedded skeleton; see
 * {@link materializeEmbeddedUi} for why tests override it.
 */
export async function materializeEmbeddedSkeleton(
  archivePath?: string,
): Promise<string | null> {
  const source = archivePath ?? (await embeddedArchivePath('skeleton'));
  if (!source) return null;
  const extracted = await extractEmbeddedArchive(source, tmpdir(), 'skeleton');
  if (!extracted) return null;
  if (!existsSync(join(extracted, 'system'))) {
    rmSync(extracted, { recursive: true, force: true });
    return null;
  }
  return extracted;
}

/**
 * Seed OP_HOME's managed system/ tree from the embedded skeleton, falling
 * back to local resolution (repo checkout / OPENPALM_SKELETON_DIR /
 * OPENPALM_REPO_ROOT) when no skeleton was compiled in.
 * Thin wrapper around {@link materializeEmbeddedSkeleton} + applyHomeSeed
 * shared by `install.ts` (pre-wizard seed) and `ui-server.ts` (spawnUiChild's
 * skeleton seed before every spawn — applyHomeSeed's own tree-overwrite is
 * what keeps repeat calls at the same version cheap, not a check here).
 */
export async function seedSkeletonFromEmbedded(
  applyHomeSeed: (repoRef: string, homeDir: string, configDir: string, dataDir: string) => Promise<unknown>,
  homeDir: string,
  configDir: string,
  dataDir: string,
): Promise<void> {
  const extracted = await materializeEmbeddedSkeleton();
  if (!extracted) {
    await applyHomeSeed(PLATFORM_VERSION, homeDir, configDir, dataDir);
    return;
  }
  const previous = process.env.OPENPALM_SKELETON_DIR;
  try {
    process.env.OPENPALM_SKELETON_DIR = extracted;
    await applyHomeSeed(PLATFORM_VERSION, homeDir, configDir, dataDir);
  } finally {
    if (previous === undefined) delete process.env.OPENPALM_SKELETON_DIR;
    else process.env.OPENPALM_SKELETON_DIR = previous;
    rmSync(extracted, { recursive: true, force: true });
  }
}
