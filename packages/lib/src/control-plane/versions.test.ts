/**
 * Unit tests for configured image versions and channel preference.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	readChannelPreference,
	writeChannelPreference,
	writeVersions,
	readVersions,
	ensureVersionDefaults,
	advanceManagedImageVersions
} from './versions.js';
import type { ControlPlaneState } from './types.js';
import { distTagForVersion, PLATFORM_VERSION } from './versioning.js';

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
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			'OP_UI_CHANNEL=next\nOP_ASSISTANT_VERSION=0.12.0\n'
		);
		writeVersions(home.state, {
			OP_ASSISTANT_VERSION: 'latest',
			OP_GUARDIAN_VERSION: 'next'
		});
		const content = readFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'utf-8');
		expect(content).toContain('OP_UI_CHANNEL=next');
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

	it('preserves an operator-selected exact pin', () => {
		ensureVersionDefaults(home.state);
		writeVersions(home.state, { OP_ASSISTANT_VERSION: '0.12.0' });

		advanceManagedImageVersions(home.state, '0.12.0', '0.13.1');

		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.12.0');
	});
});

// ── readChannelPreference / writeChannelPreference ───────────────────────────

describe('readChannelPreference', () => {
	let home: ReturnType<typeof makeState>;
	beforeEach(() => {
		home = makeState();
	});
	afterEach(() => {
		home.cleanup();
	});

	it('defaults to the running platform release channel when unset', () => {
		expect(readChannelPreference(home.state)).toBe(distTagForVersion(PLATFORM_VERSION));
	});

	it("reads 'next' from state file", () => {
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_UI_CHANNEL=next\n');
		expect(readChannelPreference(home.state)).toBe('next');
	});

	it("reads 'latest' from state file", () => {
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_UI_CHANNEL=latest\n');
		expect(readChannelPreference(home.state)).toBe('latest');
	});

	it('falls back to the platform channel for unrecognized values', () => {
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_UI_CHANNEL=bogus\n');
		expect(readChannelPreference(home.state)).toBe(distTagForVersion(PLATFORM_VERSION));
	});

	it('falls back to legacy stack.env (dual-read §1a)', () => {
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_UI_CHANNEL=next\n');
		expect(readChannelPreference(home.state)).toBe('next');
	});

	it('state file wins over legacy', () => {
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_UI_CHANNEL=next\n');
		writeFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'OP_UI_CHANNEL=latest\n');
		expect(readChannelPreference(home.state)).toBe('latest');
	});
});

describe('writeChannelPreference', () => {
	let home: ReturnType<typeof makeState>;
	beforeEach(() => {
		home = makeState();
	});
	afterEach(() => {
		home.cleanup();
	});

	it('writes to state file and is readable back', () => {
		writeChannelPreference(home.state, 'next');
		expect(readChannelPreference(home.state)).toBe('next');
		writeChannelPreference(home.state, 'latest');
		expect(readChannelPreference(home.state)).toBe('latest');
	});

	it('throws on invalid channel', () => {
		expect(() => writeChannelPreference(home.state, 'alpha')).toThrow(/Invalid channel/);
		expect(() => writeChannelPreference(home.state, '')).toThrow(/Invalid channel/);
	});

	it('write is atomic — does not corrupt existing keys in state file', () => {
		writeVersions(home.state, { OP_ASSISTANT_VERSION: '0.12.0' });
		writeChannelPreference(home.state, 'next');
		// Both should be present
		expect(readChannelPreference(home.state)).toBe('next');
		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.12.0');
	});
});
