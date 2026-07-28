#!/usr/bin/env node
/** Build the deterministic host asset release unit. */
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const version =
	process.argv[2] ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const outputDir = resolve(process.argv[3] ?? join(root, 'dist'));
const uiSource = join(root, 'packages', 'ui', 'build');
const skeletonSource = join(root, 'packages', 'skeleton');
const uiManifest = JSON.parse(readFileSync(join(root, 'packages', 'ui', 'package.json'), 'utf8'));
const harness = Number(uiManifest.minHarnessContract);

if (!existsSync(join(uiSource, 'index.js'))) throw new Error(`UI build is missing: ${uiSource}`);
if (!Number.isSafeInteger(harness) || harness < 1)
	throw new Error('packages/ui/package.json must declare a positive minHarnessContract');

const work = mkdtempSync(join(tmpdir(), 'openpalm-host-assets-'));
try {
	mkdirSync(outputDir, { recursive: true });
	cpSync(uiSource, join(work, 'ui'), { recursive: true });
	cpSync(skeletonSource, join(work, 'skeleton'), { recursive: true });
	writeFileSync(
		join(work, 'manifest.json'),
		`${JSON.stringify(
			{
				platformVersion: version,
				minHarnessContract: harness
			},
			null,
			2
		)}\n`
	);

	const asset = `openpalm-host-assets-${version}.tar.gz`;
	const destination = join(outputDir, asset);
	execFileSync('tar', [
		'--create',
		'--gzip',
		'--file',
		destination,
		'--directory',
		work,
		'--sort=name',
		'--mtime=UTC 1970-01-01',
		'--owner=0',
		'--group=0',
		'--numeric-owner',
		'manifest.json',
		'ui',
		'skeleton'
	]);
	const checksum = createHash('sha256').update(readFileSync(destination)).digest('hex');
	writeFileSync(`${destination}.sha256`, `${checksum}  ${asset}\n`);
	console.log(destination);
} finally {
	rmSync(work, { recursive: true, force: true });
}
