#!/usr/bin/env bun
/**
 * Prebuild step for the CLI's release binaries.
 *
 * Packs the shared `packages/ui/build` output and `packages/skeleton` into
 * deterministic tar.gz archives under packages/cli/embedded/, which
 * `bun build --compile` then embeds directly into the binary (see
 * src/lib/embedded-assets.ts). Run this before each `build:*` script — every
 * `build:*` script in package.json already does.
 *
 * A source checkout ships tiny placeholder archives (see embedded/README.md)
 * so `embedded-assets.ts`'s `with { type: 'file' }` imports always resolve
 * without this script having run — a plain `bun run src/main.ts` treats the
 * placeholder as "nothing embedded" and falls back to local resolution.
 *
 * A missing source directory is FATAL here. Every `build:*` script runs this
 * first, and those scripts exist only to produce release binaries: a binary
 * that embedded the placeholder would compile and start, then fail to serve a
 * UI on a user's machine, because the local-resolution fallback finds nothing
 * outside a repo checkout. Failing the build is the only way that stays
 * caught. Set OPENPALM_ALLOW_PLACEHOLDER_EMBED=1 to compile a deliberately
 * UI-less binary (harness smoke tests); nothing in release does.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c as createTar } from 'tar';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(cliRoot, '..', '..');
const embeddedDir = join(cliRoot, 'embedded');

const allowPlaceholder = process.env.OPENPALM_ALLOW_PLACEHOLDER_EMBED === '1';

async function pack(label: string, sourceDir: string, outFile: string): Promise<void> {
  if (!existsSync(sourceDir)) {
    if (allowPlaceholder) {
      console.warn(`[pack-embedded-assets] ${label} not found at ${sourceDir} — leaving ${outFile} as-is (OPENPALM_ALLOW_PLACEHOLDER_EMBED=1).`);
      return;
    }
    throw new Error(
      `[pack-embedded-assets] ${label} not found at ${sourceDir}. The binary would embed the dev placeholder and ship without a ${label}. Build it first (\`bun run ui:build\` for the UI build), or set OPENPALM_ALLOW_PLACEHOLDER_EMBED=1 to compile a deliberately UI-less binary.`,
    );
  }
  // Sorted top-level entries: deterministic archive contents regardless of
  // directory-listing order across platforms/filesystems.
  const entries = readdirSync(sourceDir).sort();
  await createTar(
    // `dot: true` — node-tar ignores dotfiles by default, but the UI build's
    // .openpalm-ui-version stamp (and the skeleton's own dotfiles) must survive.
    { gzip: true, file: outFile, cwd: sourceDir, portable: true, noMtime: true, dot: true },
    entries,
  );
  console.log(`[pack-embedded-assets] packed ${label} -> ${outFile}`);
}

await pack('UI build', join(repoRoot, 'packages', 'ui', 'build'), join(embeddedDir, 'ui-build.tar.gz'));
await pack('skeleton', join(repoRoot, 'packages', 'skeleton'), join(embeddedDir, 'skeleton.tar.gz'));
