/**
 * #540 — compose project rename handling.
 *
 * A rename recorded at save time (OP_PREVIOUS_PROJECT_NAME in the app-written
 * state env) must make the next locked apply tear down the OUTGOING project —
 * and only when that project provably belongs to this install.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerResult, ExistingProject } from './docker.js';
import { parseEnvFile } from './env.js';
import { stateEnvFile } from './home.js';
import {
	clearRecordedProjectRename,
	PREVIOUS_PROJECT_NAME_KEY,
	recordProjectRename,
	teardownRenamedProject
} from './project-rename.js';
import type { ControlPlaneState } from './types.js';

let home = '';
let savedOpHome: string | undefined;

function makeState(): ControlPlaneState {
	return {
		homeDir: home,
		configDir: join(home, 'config'),
		stashDir: join(home, 'knowledge'),
		workspaceDir: join(home, 'workspace'),
		dataDir: join(home, 'data'),
		stackDir: join(home, 'system', 'stack'),
		services: {},
		artifacts: { compose: '' },
		artifactMeta: []
	} as unknown as ControlPlaneState;
}

function writeStackEnv(content: string): void {
	writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), content);
}

function recordedMarker(): string {
	return parseEnvFile(stateEnvFile(home))[PREVIOUS_PROJECT_NAME_KEY] ?? '';
}

function makeDeps(overrides: { existing?: ExistingProject; downResult?: DockerResult }): {
	deps: Parameters<typeof teardownRenamedProject>[1];
	calls: { detect: Array<{ projectName: string; expectedWorkingDir: string }>; down: string[] };
} {
	const calls = {
		detect: [] as Array<{ projectName: string; expectedWorkingDir: string }>,
		down: [] as string[]
	};
	return {
		calls,
		deps: {
			detectExistingProject: async (opts) => {
				calls.detect.push(opts);
				return overrides.existing ?? { exists: false, isOurs: false, workingDir: '' };
			},
			composeDownProject: async (projectName) => {
				calls.down.push(projectName);
				return overrides.downResult ?? { ok: true, stdout: '', stderr: '', code: 0 };
			}
		}
	};
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'openpalm-rename-'));
	mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
	mkdirSync(join(home, 'state'), { recursive: true });
	savedOpHome = process.env.OP_HOME;
	process.env.OP_HOME = home;
});

afterEach(() => {
	if (savedOpHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = savedOpHome;
	rmSync(home, { recursive: true, force: true });
});

describe('recordProjectRename', () => {
	it('records the outgoing name in the state env', () => {
		recordProjectRename(home, 'openpalm', 'my-agent');
		expect(recordedMarker()).toBe('openpalm');
	});

	it('is a no-op when the name did not change', () => {
		recordProjectRename(home, 'openpalm', 'openpalm');
		expect(recordedMarker()).toBe('');
	});

	it('keeps the ORIGINAL running name across rename chains (A→B→C keeps A)', () => {
		recordProjectRename(home, 'a', 'b');
		recordProjectRename(home, 'b', 'c');
		expect(recordedMarker()).toBe('a');
	});

	it('clears the marker when renaming back to the still-running project (A→B→A)', () => {
		recordProjectRename(home, 'a', 'b');
		recordProjectRename(home, 'b', 'a');
		expect(recordedMarker()).toBe('');
	});

	it('clearRecordedProjectRename empties the marker', () => {
		recordProjectRename(home, 'a', 'b');
		clearRecordedProjectRename(home);
		expect(recordedMarker()).toBe('');
	});
});

describe('teardownRenamedProject', () => {
	it('no-ops when no rename is recorded', async () => {
		writeStackEnv('OP_PROJECT_NAME=my-agent\n');
		const { deps, calls } = makeDeps({});
		const result = await teardownRenamedProject(makeState(), deps);
		expect(result).toEqual({ downed: null, warning: null, blocked: false });
		expect(calls.detect.length).toBe(0);
		expect(calls.down.length).toBe(0);
	});

	it('downs the old project when it is ours, then clears the marker', async () => {
		writeStackEnv('OP_PROJECT_NAME=my-agent\n');
		recordProjectRename(home, 'openpalm', 'my-agent');
		const state = makeState();
		const { deps, calls } = makeDeps({
			existing: { exists: true, isOurs: true, workingDir: state.stackDir }
		});
		const result = await teardownRenamedProject(state, deps);
		expect(result.downed).toBe('openpalm');
		expect(result.warning).toBeNull();
		expect(result.blocked).toBe(false);
		expect(calls.detect).toEqual([{ projectName: 'openpalm', expectedWorkingDir: state.stackDir }]);
		expect(calls.down).toEqual(['openpalm']);
		expect(recordedMarker()).toBe('');
	});

	it('refuses to touch a FOREIGN project with the old name (clears marker, warns)', async () => {
		writeStackEnv('OP_PROJECT_NAME=my-agent\n');
		recordProjectRename(home, 'openpalm', 'my-agent');
		const { deps, calls } = makeDeps({
			existing: { exists: true, isOurs: false, workingDir: '/somewhere/else' }
		});
		const result = await teardownRenamedProject(makeState(), deps);
		expect(result.downed).toBeNull();
		expect(result.warning).toContain('another install');
		expect(result.blocked).toBe(false);
		expect(calls.down.length).toBe(0);
		expect(recordedMarker()).toBe('');
	});

	it('clears the marker without down when nothing runs under the old name', async () => {
		writeStackEnv('OP_PROJECT_NAME=my-agent\n');
		recordProjectRename(home, 'openpalm', 'my-agent');
		const { deps, calls } = makeDeps({
			existing: { exists: false, isOurs: false, workingDir: '' }
		});
		const result = await teardownRenamedProject(makeState(), deps);
		expect(result).toEqual({ downed: null, warning: null, blocked: false });
		expect(calls.down.length).toBe(0);
		expect(recordedMarker()).toBe('');
	});

	it('KEEPS the marker and BLOCKS when the down fails, so callers abort and the next apply retries', async () => {
		writeStackEnv('OP_PROJECT_NAME=my-agent\n');
		recordProjectRename(home, 'openpalm', 'my-agent');
		const state = makeState();
		const { deps } = makeDeps({
			existing: { exists: true, isOurs: true, workingDir: state.stackDir },
			downResult: { ok: false, stdout: '', stderr: 'daemon exploded', code: 1 }
		});
		const result = await teardownRenamedProject(state, deps);
		expect(result.downed).toBeNull();
		expect(result.warning).toContain('daemon exploded');
		expect(result.blocked).toBe(true);
		expect(recordedMarker()).toBe('openpalm');
	});

	it('treats a marker equal to the current name as a reverted rename (clears, no docker calls)', async () => {
		writeStackEnv('OP_PROJECT_NAME=openpalm\n');
		// Simulate a stale marker equal to the current name (e.g. legacy state).
		writeFileSync(stateEnvFile(home), `${PREVIOUS_PROJECT_NAME_KEY}=openpalm\n`);
		const { deps, calls } = makeDeps({});
		const result = await teardownRenamedProject(makeState(), deps);
		expect(result).toEqual({ downed: null, warning: null, blocked: false });
		expect(calls.detect.length).toBe(0);
		expect(calls.down.length).toBe(0);
		expect(recordedMarker()).toBe('');
	});
});
