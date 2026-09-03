/**
 * Unit tests for configured image versions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	writeVersions,
	readVersionPins,
	resolveVersions,
	stripRetiredStackEnvKeys
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

describe('image tag resolution', () => {
	let home: ReturnType<typeof makeState>;
	beforeEach(() => {
		home = makeState();
	});
	afterEach(() => {
		home.cleanup();
	});

	const envPath = () => join(home.state.homeDir, 'state', 'stack.env');

	// #679: a row in stack.env exists only because a human put it there, so a
	// row IS a pin and no row means "follow the release". Nothing records which
	// is which, because nothing can write one by accident any more.
	it('reports a row as a pin', () => {
		writeFileSync(envPath(), 'OP_ASSISTANT_VERSION=0.12.0\n');
		expect(readVersionPins(home.state)).toEqual({ OP_ASSISTANT_VERSION: '0.12.0' });
	});

	it('reports absence as absence, never as a default', () => {
		writeFileSync(envPath(), 'OP_ASSISTANT_VERSION=0.12.0\n');
		const pins = readVersionPins(home.state);
		expect(pins.OP_GUARDIAN_VERSION).toBeUndefined();
		expect(Object.hasOwn(pins, 'OP_GUARDIAN_VERSION')).toBe(false);
	});

	// A filled-in default is indistinguishable from a pin — which is precisely
	// how a live stack sat frozen on 0.13.1 while every update reported success.
	it('treats a blank row as no pin, the way compose does', () => {
		writeFileSync(envPath(), 'OP_ASSISTANT_VERSION=\n');
		expect(readVersionPins(home.state).OP_ASSISTANT_VERSION).toBeUndefined();
	});

	it('resolves an unpinned image to the release default the compose file carries', () => {
		writeFileSync(envPath(), 'OP_ASSISTANT_VERSION=0.12.0\n');
		const resolved = resolveVersions(home.state);
		expect(resolved.OP_ASSISTANT_VERSION).toBe('0.12.0');
		expect(resolved.OP_GUARDIAN_VERSION).toBe(PLATFORM_VERSION);
		expect(resolved.OP_VOICE_VERSION).toBe('latest');
	});

	it('writes latest and next honestly to the state file', () => {
		// OP_UNRELATED_KEY stands in for any pre-existing stack.env key that
		// writeVersions has no business touching — it must survive untouched.
		writeFileSync(envPath(), 'OP_UNRELATED_KEY=next\nOP_ASSISTANT_VERSION=0.12.0\n');
		writeVersions(home.state, {
			OP_ASSISTANT_VERSION: 'latest',
			OP_GUARDIAN_VERSION: 'next'
		});
		const content = readFileSync(envPath(), 'utf-8');
		expect(content).toContain('OP_UNRELATED_KEY=next');
		expect(content).toContain('OP_ASSISTANT_VERSION=latest');
		expect(content).toContain('OP_GUARDIAN_VERSION=next');
	});

	// THE UNPIN. Before #679 there was none, from any surface: the API rejected
	// an empty tag and no writer ever removed a row.
	it('an empty value removes the row, so the image follows the release again', () => {
		writeFileSync(envPath(), 'OP_UNRELATED_KEY=keep\nOP_ASSISTANT_VERSION=0.12.0\n');

		writeVersions(home.state, { OP_ASSISTANT_VERSION: '' });

		const content = readFileSync(envPath(), 'utf-8');
		expect(content).not.toContain('OP_ASSISTANT_VERSION');
		expect(content).toContain('OP_UNRELATED_KEY=keep');
		expect(readVersionPins(home.state).OP_ASSISTANT_VERSION).toBeUndefined();
		expect(resolveVersions(home.state).OP_ASSISTANT_VERSION).toBe(PLATFORM_VERSION);
	});

	it('sets and clears in one write', () => {
		writeFileSync(envPath(), 'OP_ASSISTANT_VERSION=0.12.0\nOP_GUARDIAN_VERSION=0.12.0\n');

		writeVersions(home.state, { OP_ASSISTANT_VERSION: '', OP_GUARDIAN_VERSION: '0.13.1' });

		expect(readVersionPins(home.state)).toEqual({ OP_GUARDIAN_VERSION: '0.13.1' });
	});

	it('refuses an unknown key', () => {
		expect(() => writeVersions(home.state, { OP_NOPE_VERSION: '1.0.0' })).toThrow(/unknown version key/i);
	});

	// The compose services append `-cpu` / `-cu121` / `-rocm6` themselves, so
	// this key holds the base tag. Pasting the tag you can see on a running
	// container ("latest-cpu") produced voice:latest-cpu-cpu — an image that
	// cannot exist — and every later update failed on the unresolvable
	// reference with nothing pointing back at this field.
	it('rejects a voice version that already carries an accelerator suffix', () => {
		for (const bad of ['latest-cpu', '0.13.0-cu121', '1.2.3-rocm6', 'latest-CPU']) {
			expect(() => writeVersions(home.state, { OP_VOICE_VERSION: bad })).toThrow(/base image tag/i);
		}
	});

	it('names the corrected value in the rejection', () => {
		expect(() => writeVersions(home.state, { OP_VOICE_VERSION: 'latest-cpu' })).toThrow(
			/Use "latest" instead of "latest-cpu"/
		);
	});

	it('still accepts a bare voice tag', () => {
		writeVersions(home.state, { OP_VOICE_VERSION: 'latest' });
		expect(readVersionPins(home.state).OP_VOICE_VERSION).toBe('latest');
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

	it('is idempotent', () => {
		writeFileSync(envPath(), 'OP_TOOL_AKM_VERSION=0.8.14\nOP_ASSISTANT_VERSION=0.13.0\n');
		expect(stripRetiredStackEnvKeys(home.state)).toBe(true);
		expect(stripRetiredStackEnvKeys(home.state)).toBe(false);
		expect(readFileSync(envPath(), 'utf-8')).toContain('OP_ASSISTANT_VERSION=0.13.0');
	});

});
