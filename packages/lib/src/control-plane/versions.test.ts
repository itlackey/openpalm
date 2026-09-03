/**
 * Unit tests for configured image versions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	writeVersions,
	readVersions,
	ensureVersionDefaults,
	setPlatformImageVersions,
	stripRetiredStackEnvKeys,
	readPinnedImages,
	writePinnedImages
} from './versions.js';
import type { ControlPlaneState } from './types.js';
import { PLATFORM_VERSION } from './versioning.js';

// ── Harness ──────────────────────────────────────────────────────────────────

function makeState(): { state: ControlPlaneState; cleanup: () => void } {
	const homeDir = mkdtempSync(join(tmpdir(), 'op-versions-test-'));
	mkdirSync(join(homeDir, 'state'), { recursive: true });
	mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
	mkdirSync(join(homeDir, 'state'), { recursive: true });
	const state: ControlPlaneState = {
		homeDir,
		stackDir: join(homeDir, 'system', 'stack'),
		stashDir: join(homeDir, 'knowledge'),
		configDir: join(homeDir, 'config'),
		dataDir: join(homeDir, 'data'),
		workspaceDir: join(homeDir, 'workspace'),
		services: {},
		artifacts: { compose: '' },
		artifactMeta: []
	};
	return {
		state,
		cleanup: () => rmSync(homeDir, { recursive: true, force: true })
	};
}

describe('version configuration', () => {
	let home: ReturnType<typeof makeState>;
	beforeEach(() => {
		home = makeState();
	});
	afterEach(() => {
		home.cleanup();
	});

	it('reads a recorded pin from stack.env', () => {
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_ASSISTANT_VERSION=0.12.0\n');
		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.12.0');
	});

	it('falls back to the default for a key stack.env does not record', () => {
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_ASSISTANT_VERSION=0.12.0\n');
		expect(readVersions(home.state).OP_GUARDIAN_VERSION).toBe(PLATFORM_VERSION);
	});

	it('a moving state tag wins over the legacy configured version', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			'OP_ASSISTANT_VERSION=0.13.0-beta.6\n'
		);
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_ASSISTANT_VERSION=next\n');
		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('next');
	});

	it('writes latest and next honestly to the state file', () => {
		// OP_UNRELATED_KEY stands in for any pre-existing stack.env key that
		// writeVersions has no business touching — it must survive untouched.
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			'OP_UNRELATED_KEY=next\nOP_ASSISTANT_VERSION=0.12.0\n'
		);
		writeVersions(home.state, {
			OP_ASSISTANT_VERSION: 'latest',
			OP_GUARDIAN_VERSION: 'next'
		});
		const content = readFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'utf-8');
		expect(content).toContain('OP_UNRELATED_KEY=next');
		expect(content).toContain('OP_ASSISTANT_VERSION=latest');
		expect(content).toContain('OP_GUARDIAN_VERSION=next');
	});

	it('falls back to the documented defaults', () => {
		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe(PLATFORM_VERSION);
	});

	it('writes missing defaults without changing an existing pin', () => {
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_ASSISTANT_VERSION=0.12.0\n');

		ensureVersionDefaults(home.state);

		const content = readFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'utf-8');
		expect(content).toContain('OP_ASSISTANT_VERSION=0.12.0');
		expect(content).toContain(`OP_GUARDIAN_VERSION=${PLATFORM_VERSION}`);
		expect(content).toContain(`OP_PORTAL_VERSION=${PLATFORM_VERSION}`);
		expect(content).toContain('OP_VOICE_VERSION=latest');
	});

	// #679: the marker protocol is gone. An update deploys THIS release's
	// images over whatever the platform keys hold — a stale tag, a hand-set
	// one, or a `rollback-generation-*` tag preserved by a failed upgrade.
	// Deciding which values an update was "allowed" to touch is exactly what
	// silently froze a live 0.13.1 stack while reporting success.
	it('sets every platform image to the release, whatever the previous value was', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			[
				'OP_ASSISTANT_VERSION=0.12.0',
				'OP_GUARDIAN_VERSION=rollback-generation-1',
				'OP_PORTAL_VERSION=custom-build',
				'OP_VOICE_VERSION=latest',
			].join('\n')
		);

		setPlatformImageVersions(home.state, '0.13.1');

		const versions = readVersions(home.state);
		expect(versions.OP_ASSISTANT_VERSION).toBe('0.13.1');
		expect(versions.OP_GUARDIAN_VERSION).toBe('0.13.1');
		expect(versions.OP_PORTAL_VERSION).toBe('0.13.1');
	});

	// The live regression (#679): fwdslsh on krang sat at OP_ASSISTANT_VERSION=
	// 0.13.1 with OP_MANAGED_ASSISTANT_VERSION=0.13.0. The old code read that
	// divergence as a deliberate operator pin and skipped the key, so
	// `openpalm update` reported "Update complete." while the containers were
	// recreated on the same 0.13.1 images — and would have done so on every
	// release after it.
	it('advances a home whose retired markers had diverged from the pins', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			[
				'OP_ASSISTANT_VERSION=0.13.1',
				'OP_MANAGED_ASSISTANT_VERSION=0.13.0',
				'OP_GUARDIAN_VERSION=0.13.1',
				'OP_MANAGED_GUARDIAN_VERSION=0.13.0',
				'OP_PORTAL_VERSION=0.13.1',
				'OP_MANAGED_PORTAL_VERSION=0.13.0',
				''
			].join('\n')
		);

		setPlatformImageVersions(home.state, '0.13.3');
		ensureVersionDefaults(home.state);

		const versions = readVersions(home.state);
		expect(versions.OP_ASSISTANT_VERSION).toBe('0.13.3');
		expect(versions.OP_GUARDIAN_VERSION).toBe('0.13.3');
		expect(versions.OP_PORTAL_VERSION).toBe('0.13.3');
		expect(readFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'utf-8')).not.toContain('OP_MANAGED_');
	});

	// Voice images are accelerator-variant suffixed (`latest-cpu`,
	// `v1.4.0-cu121`) and ship on their own cadence — no bare platform-version
	// voice image is ever published, so writing one points compose at a tag
	// that does not exist. The only per-service exception left.
	it('never writes a platform version into the voice tag', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			'OP_VOICE_VERSION=latest\n'
		);

		setPlatformImageVersions(home.state, '0.13.1');

		expect(readVersions(home.state).OP_VOICE_VERSION).toBe('latest');
	});

	// A dev tag is a local build no registry has; repointing it at a published
	// release would replace the images a developer is running. Checkable by
	// looking at the value — no second key required.
	it('leaves a dev tag alone', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			'OP_ASSISTANT_VERSION=dev\nOP_GUARDIAN_VERSION=dev\nOP_PORTAL_VERSION=dev\n'
		);

		setPlatformImageVersions(home.state, '0.13.1');

		const versions = readVersions(home.state);
		expect(versions.OP_ASSISTANT_VERSION).toBe('dev');
		expect(versions.OP_GUARDIAN_VERSION).toBe('dev');
	});

	it('reports what it wrote AND what it skipped, so update can print both', () => {
		const result = setPlatformImageVersions(home.state, '0.13.1');
		expect(result.updated).toEqual({
			OP_ASSISTANT_VERSION: '0.13.1',
			OP_GUARDIAN_VERSION: '0.13.1',
			OP_PORTAL_VERSION: '0.13.1'
		});
		expect(result.skipped).toEqual([
			{ key: 'OP_VOICE_VERSION', version: 'latest', reason: 'voice' }
		]);
	});

	// The feature the marker protocol was there to provide, restored as one
	// explicit bit: an operator pin holds across updates, and the update says
	// out loud that it held.
	it('honours an operator pin and reports it as skipped', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			[
				'OP_ASSISTANT_VERSION=0.13.1',
				'OP_GUARDIAN_VERSION=0.13.1',
				'OP_PORTAL_VERSION=0.13.1',
				'OP_PINNED_IMAGES=assistant',
				''
			].join('\n')
		);

		const result = setPlatformImageVersions(home.state, '0.13.3');

		const versions = readVersions(home.state);
		expect(versions.OP_ASSISTANT_VERSION).toBe('0.13.1');
		expect(versions.OP_GUARDIAN_VERSION).toBe('0.13.3');
		expect(result.skipped).toContainEqual({
			key: 'OP_ASSISTANT_VERSION',
			version: '0.13.1',
			reason: 'pinned'
		});
	});

	it('unpinning lets the next update move the image again', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			'OP_ASSISTANT_VERSION=0.13.1\nOP_PINNED_IMAGES=assistant\n'
		);
		setPlatformImageVersions(home.state, '0.13.3');
		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.13.1');

		writePinnedImages(home.state, []);
		setPlatformImageVersions(home.state, '0.13.3');

		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.13.3');
	});

	// #679 migration: an operator pin recorded in the retired markers (blank
	// marker) must survive their deletion. A DIVERGENT marker is the drift that
	// froze updates while reporting success — it was never an operator's
	// choice, so it must NOT come across as a pin.
	it('carries a real marker pin into the pin list, and divergent drift not at all', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			[
				'OP_ASSISTANT_VERSION=0.12.9',
				'OP_MANAGED_ASSISTANT_VERSION=',
				'OP_GUARDIAN_VERSION=0.13.1',
				'OP_MANAGED_GUARDIAN_VERSION=0.13.0',
				'OP_PORTAL_VERSION=0.13.1',
				'OP_MANAGED_PORTAL_VERSION=0.13.1',
				''
			].join('\n')
		);

		ensureVersionDefaults(home.state);

		expect(readPinnedImages(home.state)).toEqual(new Set(['OP_ASSISTANT_VERSION']));
		const content = readFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'utf-8');
		expect(content).not.toContain('OP_MANAGED_');
		expect(content).toContain('OP_PINNED_IMAGES=assistant');

		setPlatformImageVersions(home.state, '0.13.3');
		const versions = readVersions(home.state);
		expect(versions.OP_ASSISTANT_VERSION).toBe('0.12.9');
		expect(versions.OP_GUARDIAN_VERSION).toBe('0.13.3');
		expect(versions.OP_PORTAL_VERSION).toBe('0.13.3');
	});

	it('never re-derives pins once the pin list exists', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			'OP_ASSISTANT_VERSION=0.12.9\nOP_MANAGED_ASSISTANT_VERSION=\nOP_PINNED_IMAGES=\n'
		);

		ensureVersionDefaults(home.state);

		expect(readPinnedImages(home.state).size).toBe(0);
	});

	// The compose services append `-cpu` / `-cu121` / `-rocm6` themselves, so
	// this key holds the base tag. Pasting the tag you can see on a running
	// container ("latest-cpu") produced voice:latest-cpu-cpu — an image that
	// cannot exist — and every later update failed on the unresolvable
	// reference with nothing pointing back at this field.
	it('rejects a voice version that already carries an accelerator suffix', () => {
		for (const bad of ['latest-cpu', '0.13.0-cu121', '1.2.3-rocm6', 'latest-CPU']) {
			expect(() => writeVersions(home.state, { OP_VOICE_VERSION: bad })).toThrow(
				/base image tag/i
			);
		}
	});

	it('names the corrected value in the rejection', () => {
		expect(() => writeVersions(home.state, { OP_VOICE_VERSION: 'latest-cpu' })).toThrow(
			/Use "latest" instead of "latest-cpu"/
		);
	});

	it('still accepts a bare voice tag', () => {
		writeVersions(home.state, { OP_VOICE_VERSION: 'latest' });
		expect(readVersions(home.state).OP_VOICE_VERSION).toBe('latest');
	});

	// A value written here is what compose runs until the next update, which
	// deploys the release. No marker decides that; the rule is the same for
	// every value.
	it('a hand-set tag holds until the next update deploys the release', () => {
		ensureVersionDefaults(home.state);
		writeVersions(home.state, { OP_ASSISTANT_VERSION: '0.12.0' });
		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.12.0');

		setPlatformImageVersions(home.state, '0.13.1');

		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.13.1');
	});

	it('seeds defaults without the retired managed markers', () => {
		ensureVersionDefaults(home.state);
		const content = readFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'utf-8');
		expect(content).not.toContain('OP_MANAGED_');
	});
});

describe('retired stack.env keys', () => {
	let home: ReturnType<typeof makeState>;
	beforeEach(() => {
		home = makeState();
	});
	afterEach(() => {
		home.cleanup();
	});

	const envPath = () => join(home.state.homeDir, 'state', 'stack.env');

	it('sweeps the retired tool rows and leaves everything else alone', () => {
		// Tool management moved to per-container package.json in June 2026;
		// nothing has read these since, but every older stack.env still has them
		// sitting beside the live image tags, where they read as a pin that works.
		writeFileSync(
			envPath(),
			[
				'OP_ASSISTANT_VERSION=0.13.0',
				'OP_TOOL_AKM_VERSION=0.8.14',
				'OP_TOOL_CLAUDE_CODE_VERSION=2.1.186',
				'OP_TOOL_CODEX_VERSION=0.142.0',
				'OP_TOOL_OPENCODE_VERSION=1.17.9',
				'OP_PROJECT_NAME=splinter',
				''
			].join('\n')
		);

		expect(stripRetiredStackEnvKeys(home.state)).toBe(true);

		const after = readFileSync(envPath(), 'utf-8');
		expect(after).not.toContain('OP_TOOL_');
		expect(after).toContain('OP_ASSISTANT_VERSION=0.13.0');
		expect(after).toContain('OP_PROJECT_NAME=splinter');
	});

	// The incident: the pre-0.13 release model wrote OP_GUARDIAN_NPM_VERSION,
	// 554b79bc removed the writer, and the stale row made the guardian discard
	// its correct image-baked package and install an old version from npm on
	// every boot — breaking every stack update for months. The override is gone
	// from the entrypoint; this sweep removes the row that drove it.
	it('sweeps the retired guardian package-override keys', () => {
		writeFileSync(
			envPath(),
			[
				'OP_GUARDIAN_VERSION=0.13.0',
				'OP_GUARDIAN_NPM_VERSION=0.12.52',
				'OP_GUARDIAN_PACKAGE=@openpalm/guardian',
				'OP_GUARDIAN_ENTRY=src/server.ts',
				'OP_GUARDIAN_NPMRC_FILE=/run/secrets/npmrc',
				'OP_PROJECT_NAME=splinter',
				''
			].join('\n')
		);

		expect(stripRetiredStackEnvKeys(home.state)).toBe(true);

		const after = readFileSync(envPath(), 'utf-8');
		expect(after).not.toContain('OP_GUARDIAN_NPM_VERSION');
		expect(after).not.toContain('OP_GUARDIAN_PACKAGE');
		expect(after).not.toContain('OP_GUARDIAN_ENTRY');
		expect(after).not.toContain('OP_GUARDIAN_NPMRC');
		// The image tag is a different key and must survive.
		expect(after).toContain('OP_GUARDIAN_VERSION=0.13.0');
		expect(after).toContain('OP_PROJECT_NAME=splinter');
	});

	// #679: the marker rows themselves are now retired. A home upgraded from
	// any earlier release still carries them, and a divergent pair is what
	// froze image updates while reporting success.
	it('sweeps the retired managed-version markers', () => {
		writeFileSync(
			envPath(),
			[
				'OP_ASSISTANT_VERSION=0.13.1',
				'OP_MANAGED_ASSISTANT_VERSION=0.13.0',
				'OP_MANAGED_GUARDIAN_VERSION=',
				'OP_MANAGED_PORTAL_VERSION=0.13.1',
				'OP_MANAGED_VOICE_VERSION=latest',
				''
			].join('\n')
		);

		expect(stripRetiredStackEnvKeys(home.state)).toBe(true);

		const after = readFileSync(envPath(), 'utf-8');
		expect(after).not.toContain('OP_MANAGED_');
		expect(after).toContain('OP_ASSISTANT_VERSION=0.13.1');
	});

	it('is a no-op on an env that never had them', () => {
		writeFileSync(envPath(), 'OP_ASSISTANT_VERSION=0.13.0\n');
		expect(stripRetiredStackEnvKeys(home.state)).toBe(false);
	});

	it('runs as part of the lifecycle version pass', () => {
		writeFileSync(envPath(), 'OP_TOOL_AKM_VERSION=0.8.14\n');
		ensureVersionDefaults(home.state);
		expect(readFileSync(envPath(), 'utf-8')).not.toContain('OP_TOOL_AKM_VERSION');
	});

});
