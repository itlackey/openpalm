#!/usr/bin/env node
/** Launch the freshly packaged native Admin without Docker or provider secrets. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectedAdminAssets } from './validate-release-assets.mjs';

const version = process.env.VERSION;
if (!version) throw new Error('VERSION is required');
const packaged = resolve('packages/electron/dist/packages');
const generated = mkdtempSync(join(tmpdir(), 'openpalm-packaged-smoke-'));

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		timeout: 120_000,
		cwd: generated,
		env: {
			...process.env,
			OP_HOME: join(generated, 'home'),
			OPENPALM_REPO_ROOT: '',
			OPENPALM_ADMIN_SMOKE_VERSION: version
		},
		...options
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Packaged Admin command failed: ${result.error?.message ?? result.stderr}`);
	}
	return result.stdout ?? '';
}

try {
	const platform =
		process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
	const arch = platform === 'linux' && process.arch === 'x64' ? 'x86_64' : process.arch;
	const asset = expectedAdminAssets(version).find((name) =>
		platform === 'windows' ? name.endsWith('.exe') : name.includes(`-${arch}-${platform}.`)
	);
	if (!asset) throw new Error('No release artifact supports this runner');
	let command;
	let args = ['--openpalm-release-smoke', '--disable-gpu'];
	if (platform === 'mac') {
		run('unzip', ['-q', join(packaged, asset), '-d', generated]);
		command = join(generated, 'OpenPalm Admin.app', 'Contents', 'MacOS', 'OpenPalm Admin');
	} else if (platform === 'windows') {
		const installation = join(generated, 'installed');
		run(join(packaged, asset), ['/S', `/D=${installation}`]);
		command = join(installation, 'OpenPalm Admin.exe');
	} else {
		run(join(packaged, asset), ['--appimage-extract']);
		command = 'xvfb-run';
		args = ['-a', join(generated, 'squashfs-root', 'openpalm-admin'), '--no-sandbox', ...args];
	}
	const output = run(command, args);
	if (!output.includes('OPENPALM_ADMIN_SMOKE_OK'))
		throw new Error('Packaged Admin did not confirm renderer and bridge readiness');
	console.log(`Verified packaged Admin startup: ${asset}`);
} finally {
	rmSync(generated, { recursive: true, force: true });
}
