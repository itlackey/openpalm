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
 * compiled-binary file-asset support: `import x from './f' with { type:
 * 'file' }` resolves, INSIDE a --compile binary, to a `/$bunfs/...` virtual
 * path that only `Bun.file` can read — not node:fs, and not the `tar`
 * package's own file-based extractor (both throw ENOENT against a bunfs
 * path). So materialization always: (1) reads the embedded bytes via
 * `Bun.file(...).arrayBuffer()`, (2) writes them to a REAL temp file, (3) lets
 * `tar` extract that real file into a REAL temp directory, then (4) renames
 * the temp directory into place — a half-written destination is never
 * observable.
 *
 * A source checkout ships tiny placeholder archives (an empty tar.gz holding
 * only a `.placeholder` marker) so the `with { type: 'file' }` imports below
 * always resolve without the pack step having run — `bun build --compile`
 * requires the imported file to exist even for a plain `bun run` dev
 * invocation. Extracting a placeholder never yields the expected marker
 * (`index.js` / `system/`), so both materialize* functions below detect that
 * and no-op, leaving local resolution (repo checkout / Electron
 * resourcesPath) to do its job instead — see @openpalm/lib's
 * resolveUiBuildDir / resolveLocalOpenpalmDir.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x as extractTar } from 'tar';
import { PLATFORM_VERSION, readUiBuildVersion } from '@openpalm/lib';

import uiArchivePath from '../../embedded/ui-build.tar.gz' with { type: 'file' };
import skeletonArchivePath from '../../embedded/skeleton.tar.gz' with { type: 'file' };

/**
 * Extract an embedded (possibly `/$bunfs/`) archive into a fresh real
 * directory under `parentDir` (created if needed). Returns null on any
 * failure — an unreadable or placeholder archive is "nothing embedded", not
 * an error the caller should surface.
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
 * matches, or when the embedded archive is the dev placeholder.
 *
 * Extracts to a temp directory that is a SIBLING of `${dataDir}/ui` (so the
 * final rename is same-filesystem and atomic) before swapping it in, so a
 * half-written data/ui is never observable.
 *
 * `archivePath` defaults to the real embedded UI build and is only
 * overridden by tests, which point it at a fixture archive on real disk
 * (the default embedded path resolves to a `/$bunfs/` virtual path outside a
 * compiled binary, which doesn't exist under plain `bun test`).
 */
export async function materializeEmbeddedUi(
  dataDir: string,
  archivePath: string = uiArchivePath,
): Promise<boolean> {
  const uiDir = join(dataDir, 'ui');
  if (readUiBuildVersion(uiDir) === PLATFORM_VERSION) return false;
  const extracted = await extractEmbeddedArchive(archivePath, dataDir, 'ui');
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
 * its path, or null when the embedded archive is the dev placeholder (the
 * caller falls back to @openpalm/lib's resolveLocalOpenpalmDir — a repo
 * checkout or OPENPALM_SKELETON_DIR/OPENPALM_REPO_ROOT override). The
 * returned directory is a plain scratch dir the caller owns: point
 * OPENPALM_SKELETON_DIR at it, call applyHomeSeed, then rmSync it.
 *
 * `archivePath` defaults to the real embedded skeleton; see
 * {@link materializeEmbeddedUi} for why tests override it.
 */
export async function materializeEmbeddedSkeleton(
  archivePath: string = skeletonArchivePath,
): Promise<string | null> {
  const extracted = await extractEmbeddedArchive(archivePath, tmpdir(), 'skeleton');
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
 * OPENPALM_REPO_ROOT) when the embedded archive is the dev placeholder.
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
