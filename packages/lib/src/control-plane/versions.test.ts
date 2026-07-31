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
	advanceManagedImageVersions
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

	it('preserves an operator-selected exact pin', () => {
		ensureVersionDefaults(home.state);
		writeVersions(home.state, { OP_ASSISTANT_VERSION: '0.12.0' });

		advanceManagedImageVersions(home.state, '0.12.0', '0.13.1');

		expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe('0.12.0');
	});
});
