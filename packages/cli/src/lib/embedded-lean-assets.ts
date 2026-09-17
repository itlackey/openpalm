import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { x as extractTar } from 'tar';

async function embeddedSkeletonPath(): Promise<string | null> {
	try {
		const module = await import('../../embedded/skeleton.tar.gz', {
			with: { type: 'file' }
		});
		return module.default;
	} catch {
		return null;
	}
}

async function applyEmbeddedSkeleton(
	applyToHome: (homeDir: string) => Promise<unknown>,
	homeDir: string,
	embedded: string
): Promise<void> {
	const extraction = mkdtempSync(join(tmpdir(), 'openpalm-skeleton-'));
	const archive = join(tmpdir(), `openpalm-skeleton-${process.pid}-${crypto.randomUUID()}.tar.gz`);
	try {
		writeFileSync(archive, new Uint8Array(await Bun.file(embedded).arrayBuffer()));
		await extractTar({ file: archive, cwd: extraction, strict: true });
		if (!existsSync(join(extraction, 'system', 'stack', 'stack.compose.yml'))) {
			throw new Error('Embedded skeleton does not contain the lean managed stack.');
		}
		const previous = process.env.OPENPALM_SKELETON_DIR;
		try {
			process.env.OPENPALM_SKELETON_DIR = extraction;
			await applyToHome(homeDir);
		} finally {
			if (previous === undefined) delete process.env.OPENPALM_SKELETON_DIR;
			else process.env.OPENPALM_SKELETON_DIR = previous;
		}
	} finally {
		// Both paths are generated for this call; no operator path is removed.
		rmSync(archive, { force: true });
		rmSync(extraction, { recursive: true, force: true });
	}
}

export async function seedLeanSkeletonFromEmbedded(
	applyToHome: (homeDir: string) => Promise<unknown>,
	homeDir: string
): Promise<void> {
	const embedded = await embeddedSkeletonPath();
	if (!embedded) {
		await applyToHome(homeDir);
		return;
	}
	await applyEmbeddedSkeleton(applyToHome, homeDir, embedded);
}
