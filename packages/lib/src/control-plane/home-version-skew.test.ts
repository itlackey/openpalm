/**
 * Regression tests for #636: nothing compared a home's recorded version
 * stamps (`.skeleton-version`, `state/schema-version`) against the code
 * running now before writing to it, so an older app pointed at a home a
 * newer app had already upgraded silently downgraded it — advancing version
 * pins to its own older PLATFORM_VERSION, overwriting the managed `system/`
 * tree, and re-stamping `.skeleton-version` backwards.
 *
 * `detectHomeVersionSkew`/`assertHomeNotNewerThanApp` (versions.ts) are the
 * one guard both `clearRollbackPins` and lifecycle.ts's entry points now
 * check first. This file unit-tests the guard itself and proves
 * `clearRollbackPins` refuses instead of downgrading; lifecycle.test.ts-style
 * coverage for the install/update/upgrade entry points lives in
 * home-version-skew-lifecycle.test.ts (mocks Docker, so it belongs beside the
 * other lifecycle mock-module tests).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	assertHomeNotNewerThanApp,
	clearRollbackPins,
	detectHomeVersionSkew
} from './versions.js';
import type { ControlPlaneState } from './types.js';
import { PLATFORM_VERSION } from './versioning.js';
import { SKELETON_VERSION_STAMP } from './ui-assets.js';
import { HOME_SCHEMA_VERSION, homeSchemaVersionFile } from './home.js';

// ── Harness ──────────────────────────────────────────────────────────────────

function makeState(): { state: ControlPlaneState; cleanup: () => void } {
	const homeDir = mkdtempSync(join(tmpdir(), 'op-version-skew-test-'));
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
	return { state, cleanup: () => rmSync(homeDir, { recursive: true, force: true }) };
}

function stampSkeletonVersion(homeDir: string, version: string): void {
	writeFileSync(join(homeDir, SKELETON_VERSION_STAMP), `${version}\n`);
}

function stampSchemaVersion(homeDir: string, version: number): void {
	writeFileSync(homeSchemaVersionFile(homeDir), `${version}\n`);
}

describe('detectHomeVersionSkew (#636)', () => {
	let home: ReturnType<typeof makeState>;
	beforeEach(() => {
		home = makeState();
	});
	afterEach(() => home.cleanup());

	it('reports no skew when .skeleton-version is absent (fresh install)', () => {
		const skew = detectHomeVersionSkew(home.state);
		expect(skew.newer).toBe(false);
		expect(skew.homeSkeletonVersion).toBeNull();
	});

	it('reports no skew for a non-semver stamp (very old / hand-edited home)', () => {
		stampSkeletonVersion(home.state.homeDir, 'not-a-version');
		const skew = detectHomeVersionSkew(home.state);
		expect(skew.newer).toBe(false);
	});

	it('reports no skew when the home is older than the running app', () => {
		stampSkeletonVersion(home.state.homeDir, '0.1.0');
		expect(detectHomeVersionSkew(home.state).newer).toBe(false);
	});

	it('reports no skew when the home matches the running app exactly', () => {
		stampSkeletonVersion(home.state.homeDir, PLATFORM_VERSION);
		expect(detectHomeVersionSkew(home.state).newer).toBe(false);
	});

	it('reports skew when .skeleton-version is a newer patch than the running app', () => {
		stampSkeletonVersion(home.state.homeDir, '99.0.0');
		const skew = detectHomeVersionSkew(home.state);
		expect(skew.newer).toBe(true);
		expect(skew.homeSkeletonVersion).toBe('99.0.0');
		expect(skew.runningPlatformVersion).toBe(PLATFORM_VERSION);
	});

	it('reports skew from state/schema-version alone, even with no .skeleton-version stamp', () => {
		stampSchemaVersion(home.state.homeDir, HOME_SCHEMA_VERSION + 1);
		const skew = detectHomeVersionSkew(home.state);
		expect(skew.newer).toBe(true);
		expect(skew.homeSchemaVersion).toBe(HOME_SCHEMA_VERSION + 1);
	});

	it('does not flag skew from an EQUAL or lower schema-version', () => {
		stampSchemaVersion(home.state.homeDir, HOME_SCHEMA_VERSION);
		expect(detectHomeVersionSkew(home.state).newer).toBe(false);
	});
});

describe('assertHomeNotNewerThanApp (#636)', () => {
	let home: ReturnType<typeof makeState>;
	beforeEach(() => {
		home = makeState();
	});
	afterEach(() => home.cleanup());

	it('is a no-op when the home is not newer than the running app', () => {
		stampSkeletonVersion(home.state.homeDir, '0.1.0');
		expect(() => assertHomeNotNewerThanApp(home.state)).not.toThrow();
	});

	it('throws an actionable message naming both versions when the home is newer', () => {
		stampSkeletonVersion(home.state.homeDir, '0.99.0');
		expect(() => assertHomeNotNewerThanApp(home.state)).toThrow(
			/0\.99\.0.*0\.13\.0|OpenPalm 0\.99\.0/
		);
		try {
			assertHomeNotNewerThanApp(home.state);
			throw new Error('expected assertHomeNotNewerThanApp to throw');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain('0.99.0');
			expect(message).toContain(PLATFORM_VERSION);
			expect(message).toMatch(/refus/i);
		}
	});
});

describe('clearRollbackPins refuses on a newer home instead of downgrading it (#636)', () => {
	let home: ReturnType<typeof makeState>;
	beforeEach(() => {
		home = makeState();
	});
	afterEach(() => home.cleanup());

	it('THE BUG (would pass on unfixed code): clearing a rollback pin on a home stamped newer than this app must refuse, not advance the pin to this app\'s own older version', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			'OP_ASSISTANT_VERSION=rollback-generation-1700000000-1234-1\n' +
				'OP_GUARDIAN_VERSION=0.99.0\n' +
				'OP_MANAGED_GUARDIAN_VERSION=0.99.0\n'
		);
		// Written by a build ahead of this one — e.g. a desktop app stuck on an
		// old version (#635) pointed at a home a newer app already upgraded.
		stampSkeletonVersion(home.state.homeDir, '0.99.0');

		expect(() => clearRollbackPins(home.state)).toThrow(/0\.99\.0/);

		// Refused BEFORE writing anything: the rollback pin is exactly as it was,
		// not silently advanced to this (older) build's PLATFORM_VERSION.
		const content = readFileSync(join(home.state.homeDir, 'state', 'stack.env'), 'utf-8');
		expect(content).toContain('OP_ASSISTANT_VERSION=rollback-generation-1700000000-1234-1');
		expect(content).not.toContain(`OP_ASSISTANT_VERSION=${PLATFORM_VERSION}`);
	});

	it('still clears the pin normally once the home is not newer than this app', () => {
		writeFileSync(
			join(home.state.homeDir, 'state', 'stack.env'),
			'OP_ASSISTANT_VERSION=rollback-generation-1700000000-1234-1\n'
		);
		stampSkeletonVersion(home.state.homeDir, PLATFORM_VERSION);

		const { cleared } = clearRollbackPins(home.state);
		expect(cleared.OP_ASSISTANT_VERSION?.to).toBe(PLATFORM_VERSION);
	});
});
