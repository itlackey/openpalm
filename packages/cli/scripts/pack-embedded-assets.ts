#!/usr/bin/env bun
/**
 * Prebuild step for the CLI's release binaries.
 *
 * Packs only the lean Skeleton allowlist into a deterministic archive that
 * `bun build --compile` embeds directly into the binary.
 *
 * The output directory is gitignored and never committed, so a source
 * checkout simply has no archives and `embedded-assets.ts` falls back to
 * local resolution.
 *
 * A missing skeleton is fatal because standalone binaries have no repository
 * fallback on an operator's machine.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c as createTar } from 'tar';

import { LEAN_MANAGED_FILES, LEAN_SEEDED_FILES } from '../../lib/src/lean.js';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(cliRoot, '..', '..');
const embeddedDir = join(cliRoot, 'embedded');

const LEAN_SKELETON_FILES = [...LEAN_MANAGED_FILES, ...LEAN_SEEDED_FILES].sort();

async function pack(label: string, sourceDir: string, outFile: string): Promise<void> {
	if (!existsSync(sourceDir)) {
		throw new Error(
			`[pack-embedded-assets] ${label} not found at ${sourceDir}. The binary would ship without required runtime assets.`
		);
	}
	// The output directory is gitignored, so it is absent in a fresh clone.
	mkdirSync(dirname(outFile), { recursive: true });
	for (const relative of LEAN_SKELETON_FILES) {
		if (!existsSync(join(sourceDir, relative))) {
			throw new Error(`[pack-embedded-assets] required lean asset is missing: ${relative}`);
		}
	}
	await createTar({ gzip: true, file: outFile, cwd: sourceDir, portable: true, noMtime: true }, [
		...LEAN_SKELETON_FILES
	]);
	console.log(`[pack-embedded-assets] packed ${label} -> ${outFile}`);
}

await pack(
	'skeleton',
	join(repoRoot, 'packages', 'skeleton'),
	join(embeddedDir, 'skeleton.tar.gz')
);
