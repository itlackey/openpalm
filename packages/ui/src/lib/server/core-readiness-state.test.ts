import { describe, expect, it, beforeEach } from 'bun:test';
import {
	getCoreReadinessSnapshot,
	setCoreReadinessPhase,
	applyReadinessResult,
	resetCoreReadinessSnapshot
} from './core-readiness-state';
import type { EnsureCoreServicesReadyResult } from '@openpalm/lib/types';

describe('core-readiness-state', () => {
	beforeEach(() => {
		resetCoreReadinessSnapshot();
	});

	it('returns null when no snapshot has been set', () => {
		expect(getCoreReadinessSnapshot()).toBeNull();
	});

	it('sets a phase and returns a snapshot with defaults', () => {
		const snapshot = setCoreReadinessPhase('applying');
		expect(snapshot.phase).toBe('applying');
		expect(snapshot.checks).toEqual([]);
		expect(snapshot.diagnostics).toEqual({ failedServices: [] });
		expect(typeof snapshot.updatedAt).toBe('string');
	});

	it('persists the snapshot so getCoreReadinessSnapshot returns it', () => {
		setCoreReadinessPhase('starting');
		const snapshot = getCoreReadinessSnapshot();
		expect(snapshot).not.toBeNull();
		expect(snapshot!.phase).toBe('starting');
	});

	it('transitions through phases', () => {
		setCoreReadinessPhase('applying');
		expect(getCoreReadinessSnapshot()!.phase).toBe('applying');

		setCoreReadinessPhase('starting');
		expect(getCoreReadinessSnapshot()!.phase).toBe('starting');

		setCoreReadinessPhase('checking');
		expect(getCoreReadinessSnapshot()!.phase).toBe('checking');

		setCoreReadinessPhase('ready');
		expect(getCoreReadinessSnapshot()!.phase).toBe('ready');
	});

	it('applies a successful readiness result as phase=ready', () => {
		const result: EnsureCoreServicesReadyResult = {
			ok: true,
			code: 'ready',
			checks: [
				{ service: 'gateway', state: 'ready', status: 'running', health: 'healthy' }
			],
			diagnostics: { failedServices: [] }
		};

		const snapshot = applyReadinessResult(result);
		expect(snapshot.phase).toBe('ready');
		expect(snapshot.checks).toEqual(result.checks);
		expect(snapshot.diagnostics).toEqual(result.diagnostics);
	});

	it('applies a failed readiness result as phase=failed', () => {
		const result: EnsureCoreServicesReadyResult = {
			ok: false,
			code: 'setup_not_ready',
			checks: [
				{ service: 'gateway', state: 'not_ready', status: 'running', health: 'starting', reason: 'unhealthy' }
			],
			diagnostics: {
				failedServices: [
					{ service: 'gateway', state: 'not_ready', status: 'running', health: 'starting', reason: 'unhealthy' }
				],
				failedServiceLogs: { gateway: 'error log here' }
			}
		};

		const snapshot = applyReadinessResult(result);
		expect(snapshot.phase).toBe('failed');
		expect(snapshot.checks).toEqual(result.checks);
		expect(snapshot.diagnostics.failedServices).toHaveLength(1);
		expect(snapshot.diagnostics.failedServiceLogs!.gateway).toBe('error log here');
	});

	it('sets phase with custom checks and diagnostics', () => {
		const checks = [
			{ service: 'assistant', state: 'ready' as const, status: 'running', health: null }
		];
		const diagnostics = {
			composePsStderr: 'some warning',
			failedServices: []
		};

		const snapshot = setCoreReadinessPhase('checking', checks, diagnostics);
		expect(snapshot.checks).toEqual(checks);
		expect(snapshot.diagnostics.composePsStderr).toBe('some warning');
	});

	it('resetCoreReadinessSnapshot clears the stored snapshot', () => {
		setCoreReadinessPhase('ready');
		expect(getCoreReadinessSnapshot()).not.toBeNull();

		resetCoreReadinessSnapshot();
		expect(getCoreReadinessSnapshot()).toBeNull();
	});

	it('updatedAt is an ISO timestamp', () => {
		const snapshot = setCoreReadinessPhase('applying');
		const date = new Date(snapshot.updatedAt);
		expect(date.toISOString()).toBe(snapshot.updatedAt);
	});
});
