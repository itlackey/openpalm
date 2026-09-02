/**
 * Unit tests for #662's comparison primitive: `detectCliVersionSkew`
 * (versions.ts). #636 (home-version-skew.test.ts) stops an OLDER app from
 * silently rewriting a NEWER home; this is the mirror-image check `openpalm
 * update` (packages/cli) runs on the CLI's OWN version before deploying —
 * see update.test.ts for the CLI-level refusal/`--allow-version-skew`
 * coverage. This file only covers the pure comparison this package owns.
 */
import { describe, expect, it } from 'bun:test';
import { detectCliVersionSkew } from './versions.js';
import { PLATFORM_VERSION } from './versioning.js';

describe('detectCliVersionSkew (#662)', () => {
	it('reports no skew when the CLI matches the target exactly', () => {
		const skew = detectCliVersionSkew('0.13.1', '0.13.1');
		expect(skew.older).toBe(false);
	});

	it('reports no skew when the CLI is NEWER than the target (the normal upgrade direction)', () => {
		const skew = detectCliVersionSkew('0.14.0', '0.13.1');
		expect(skew.older).toBe(false);
	});

	it('reports skew when the CLI is older than the target release', () => {
		const skew = detectCliVersionSkew('0.13.0', '0.13.1');
		expect(skew.older).toBe(true);
		expect(skew.cliVersion).toBe('0.13.0');
		expect(skew.targetVersion).toBe('0.13.1');
	});

	it('defaults the target to this build\'s PLATFORM_VERSION', () => {
		const skew = detectCliVersionSkew('0.0.1');
		expect(skew.targetVersion).toBe(PLATFORM_VERSION);
		expect(skew.older).toBe(true);
	});

	it('never trips on a non-semver CLI version (a dev/source build)', () => {
		expect(detectCliVersionSkew('dev', '0.13.1').older).toBe(false);
	});

	it('never trips on a non-semver target', () => {
		expect(detectCliVersionSkew('0.13.0', 'main').older).toBe(false);
	});
});
