/**
 * Unit tests for configured image versions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	writeVersions,
	writeManagedVersions,
	readVersions,
	ensureVersionDefaults,
	advanceManagedImageVersions,
	stripRetiredToolVersions,
	clearRollbackPins,
	MANAGED_VERSION_MARKERS,
	SERVICE_VERSION_KEYS
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

	it('advances release-managed and rollback pins without changing custom pins', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			[
				'OP_ASSISTANT_VERSION=0.12.0',
				'OP_GUARDIAN_VERSION=rollback-generation-1',
				'OP_PORTAL_VERSION=custom-build',
				'OP_VOICE_VERSION=rollback-generation-1',
			].join('\n')
		);

		advanceManagedImageVersions(home.state, '0.12.0', '0.13.1');

		const versions = readVersions(home.state);
		expect(versions.OP_ASSISTANT_VERSION).toBe('0.13.1');
		expect(versions.OP_GUARDIAN_VERSION).toBe('0.13.1');
		expect(versions.OP_PORTAL_VERSION).toBe('custom-build');
		expect(versions.OP_VOICE_VERSION).toBe('latest');
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

	it('preserves an operator-selected exact pin', () => {
		ensureVersionDefaults(home.state);
		writeVersions(home.state, { OP_ASSISTANT_VERSION: '0.12.0' });

		advanceManagedImageVersions(home.state, '0.12.0', '0.13.1');

		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.12.0');
	});

	// D3: the marker-match arm (unlike the rollback arm just above it) used to
	// advance voice to the bare platform version too. Voice tags are
	// variant-suffixed (latest-cpu, vX.Y.Z-cu121) and publish-voice.yml never
	// publishes a bare platform-version tag, so that pointed voice at an image
	// that was never published — and since this arm also re-stamps the marker
	// to match, the bad value stuck forever.
	it('never advances a marker-armed voice version to the bare platform version', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			[
				'OP_ASSISTANT_VERSION=0.12.0',
				'OP_MANAGED_ASSISTANT_VERSION=0.12.0',
				'OP_VOICE_VERSION=latest',
				'OP_MANAGED_VOICE_VERSION=latest',
			].join('\n')
		);

		advanceManagedImageVersions(home.state, '0.12.0', '0.13.1');

		const versions = readVersions(home.state);
		expect(versions.OP_ASSISTANT_VERSION).toBe('0.13.1');
		expect(versions.OP_VOICE_VERSION).toBe('latest');
	});

	// D2: setup's own release-managed defaults must stamp the marker (so a
	// later advance recognizes them), never blank it the way an operator's
	// explicit pin (writeVersions) does.
	it('writeManagedVersions stamps the marker so a later advance recognizes the default', () => {
		writeManagedVersions(home.state, { OP_ASSISTANT_VERSION: PLATFORM_VERSION });

		const content = readFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'utf-8');
		expect(content).toContain(`OP_ASSISTANT_VERSION=${PLATFORM_VERSION}`);
		expect(content).toContain(`OP_MANAGED_ASSISTANT_VERSION=${PLATFORM_VERSION}`);

		advanceManagedImageVersions(home.state, PLATFORM_VERSION, '0.99.0');

		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.99.0');
	});
});

describe('retired OP_TOOL_*_VERSION keys', () => {
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

		expect(stripRetiredToolVersions(home.state)).toBe(true);

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

		expect(stripRetiredToolVersions(home.state)).toBe(true);

		const after = readFileSync(envPath(), 'utf-8');
		expect(after).not.toContain('OP_GUARDIAN_NPM_VERSION');
		expect(after).not.toContain('OP_GUARDIAN_PACKAGE');
		expect(after).not.toContain('OP_GUARDIAN_ENTRY');
		expect(after).not.toContain('OP_GUARDIAN_NPMRC');
		// The image tag is a different key and must survive.
		expect(after).toContain('OP_GUARDIAN_VERSION=0.13.0');
		expect(after).toContain('OP_PROJECT_NAME=splinter');
	});

	it('is a no-op on an env that never had them', () => {
		writeFileSync(envPath(), 'OP_ASSISTANT_VERSION=0.13.0\n');
		expect(stripRetiredToolVersions(home.state)).toBe(false);
	});

	it('runs as part of the lifecycle version pass', () => {
		writeFileSync(envPath(), 'OP_TOOL_AKM_VERSION=0.8.14\n');
		ensureVersionDefaults(home.state);
		expect(readFileSync(envPath(), 'utf-8')).not.toContain('OP_TOOL_AKM_VERSION');
	});

	// #639: a failed performUpgrade/runDeploy re-pins every SERVICE_VERSION_KEY
	// to a preserved rollback-generation-* tag via restoreRunningImageIds, which
	// ALWAYS leaves the OP_MANAGED_* marker blank — the exact same shape
	// writeVersions leaves after a genuine operator pin. clearRollbackPins is
	// the supported way off that pin (backing both `openpalm unpin` and the
	// admin UI's dedicated clear action).
	describe('clearRollbackPins (#639)', () => {
		it('clears every rollback- pin to the target version and re-stamps its managed marker', () => {
			// The operator's exact reported shape: rollback- values with BLANK
			// markers (restoreRunningImageIds never stamps them).
			writeFileSync(
				envPath(),
				[
					'OP_ASSISTANT_VERSION=rollback-generation-1788212586188-217761-1',
					'OP_VOICE_VERSION=rollback-generation-1788212586188-217761-1',
					'OP_GUARDIAN_VERSION=rollback-generation-1788212586188-217761-1',
					'OP_PORTAL_VERSION=rollback-generation-1788212586188-217761-1',
					'OP_MANAGED_ASSISTANT_VERSION=',
					'OP_MANAGED_GUARDIAN_VERSION=',
					'OP_MANAGED_PORTAL_VERSION=',
					'OP_MANAGED_VOICE_VERSION='
				].join('\n')
			);

			const result = clearRollbackPins(home.state, '0.13.1');

			expect(Object.keys(result.cleared).sort()).toEqual([...SERVICE_VERSION_KEYS].sort());
			for (const key of ['OP_ASSISTANT_VERSION', 'OP_GUARDIAN_VERSION', 'OP_PORTAL_VERSION'] as const) {
				expect(result.cleared[key]).toEqual({
					from: 'rollback-generation-1788212586188-217761-1',
					to: '0.13.1'
				});
			}
			expect(result.cleared.OP_VOICE_VERSION).toEqual({
				from: 'rollback-generation-1788212586188-217761-1',
				to: 'latest'
			});

			const versions = readVersions(home.state);
			expect(versions.OP_ASSISTANT_VERSION).toBe('0.13.1');
			expect(versions.OP_GUARDIAN_VERSION).toBe('0.13.1');
			expect(versions.OP_PORTAL_VERSION).toBe('0.13.1');
			expect(versions.OP_VOICE_VERSION).toBe('latest');

			// Re-stamped (not blanked) so a later advanceManagedImageVersions still
			// recognizes these as managed and keeps advancing them.
			const content = readFileSync(envPath(), 'utf-8');
			for (const key of ['OP_ASSISTANT_VERSION', 'OP_GUARDIAN_VERSION', 'OP_PORTAL_VERSION'] as const) {
				expect(content).toContain(`${MANAGED_VERSION_MARKERS[key]}=0.13.1`);
			}
			expect(content).toContain(`${MANAGED_VERSION_MARKERS.OP_VOICE_VERSION}=latest`);
		});

		it('never touches a value without the rollback- prefix, even with a blank marker (a genuine operator pin)', () => {
			writeFileSync(
				envPath(),
				[
					'OP_ASSISTANT_VERSION=rollback-generation-1',
					'OP_GUARDIAN_VERSION=my-custom-build',
					'OP_MANAGED_ASSISTANT_VERSION=',
					'OP_MANAGED_GUARDIAN_VERSION='
				].join('\n')
			);

			const result = clearRollbackPins(home.state, '0.13.1');

			expect(result.cleared.OP_ASSISTANT_VERSION).toEqual({
				from: 'rollback-generation-1',
				to: '0.13.1'
			});
			expect(result.cleared.OP_GUARDIAN_VERSION).toBeUndefined();
			expect(result.kept.OP_GUARDIAN_VERSION).toBe('my-custom-build');

			const content = readFileSync(envPath(), 'utf-8');
			expect(content).toContain('OP_GUARDIAN_VERSION=my-custom-build');
			// The operator pin's marker stays exactly as it was — untouched.
			expect(content).toMatch(/OP_MANAGED_GUARDIAN_VERSION=(\r?\n|$)/);
		});

		it('is a no-op when nothing is pinned to a rollback generation', () => {
			writeFileSync(envPath(), 'OP_ASSISTANT_VERSION=0.13.0\n');
			const before = readFileSync(envPath(), 'utf-8');

			const result = clearRollbackPins(home.state, '0.13.1');

			expect(result.cleared).toEqual({});
			expect(readFileSync(envPath(), 'utf-8')).toBe(before);
		});
	});
});
