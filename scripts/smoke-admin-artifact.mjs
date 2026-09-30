#!/usr/bin/env node
/** Launch the freshly packaged native Admin without Docker or provider secrets. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectedAdminAssets } from './validate-release-assets.mjs';

const version = process.env.VERSION;
if (!version) throw new Error('VERSION is required');
const packaged = resolve('packages/electron/dist/packages');
const generated = mkdtempSync(join(tmpdir(), 'openpalm-packaged-smoke-'));
const report = join(generated, 'startup-report.json');

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		timeout: 120_000,
		cwd: generated,
		env: {
			...process.env,
			OP_HOME: join(generated, 'home'),
			OPENPALM_REPO_ROOT: '',
			OPENPALM_ADMIN_SMOKE_VERSION: version,
			OPENPALM_ADMIN_SMOKE_REPORT: report
		},
		...options
	});
	if (result.error || result.status !== 0) {
		const detail = existsSync(report) ? readFileSync(report, 'utf8') : result.stderr;
		throw new Error(`Packaged Admin command failed: ${result.error?.message ?? detail}`);
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
	run(command, args);
	const result = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null;
	if (result?.ok !== true || result.version !== version)
		throw new Error('Packaged Admin did not confirm renderer and bridge readiness');
	console.log(`Verified packaged Admin startup: ${asset}`);
} finally {
	console.log(`Packaged smoke fixtures retained at ${generated}`);
}
