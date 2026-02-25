import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { SetupStartupServices } from '@openpalm/lib/admin/compose-runner';
import { completeSetupOrchestration } from './setup-completion';
import { getCoreReadinessSnapshot, resetCoreReadinessSnapshot } from './core-readiness-state';

describe('setup-completion phase transitions', () => {
	beforeEach(() => {
		resetCoreReadinessSnapshot();
	});

	function makeOverrides(opts: {
		composeOk?: boolean;
		readinessOk?: boolean;
		readinessThrows?: boolean;
	} = {}) {
		const { composeOk = true, readinessOk = true, readinessThrows = false } = opts;
		const phaseLog: string[] = [];

		const readinessResult = readinessOk
			? { ok: true as const, code: 'ready' as const, checks: [{ service: 'gateway', state: 'ready' as const, status: 'running', health: 'healthy' }], diagnostics: { failedServices: [] } }
			: { ok: false as const, code: 'setup_not_ready' as const, checks: [{ service: 'gateway', state: 'not_ready' as const, status: 'running', health: 'starting', reason: 'unhealthy' as const }], diagnostics: { failedServices: [{ service: 'gateway', state: 'not_ready' as const, status: 'running', health: 'starting', reason: 'unhealthy' as const }] } };

		return {
			phaseLog,
			overrides: {
				secretsEnvPath: '/tmp/config/secrets.env',
				existsSync: () => true,
				readFileSync: () => 'POSTGRES_PASSWORD=already-set\n',
				parseRuntimeEnvContent: () => ({ POSTGRES_PASSWORD: 'already-set' }),
				updateRuntimeEnvContent: () => 'unused',
				generateToken: () => 'unused',
				mkdirSync: () => undefined,
				dirname: () => '/tmp/config',
				writeFileSync: () => undefined,
				applyStack: mock(async () => {
					phaseLog.push(getCoreReadinessSnapshot()?.phase ?? 'null');
					return { ok: true };
				}),
				composeAction: mock(async () => {
					phaseLog.push(getCoreReadinessSnapshot()?.phase ?? 'null');
					return { ok: composeOk, stdout: '', stderr: composeOk ? '' : 'compose failed' };
				}),
				syncAutomations: () => undefined,
				ensureCoreServicesReady: mock(async () => {
					phaseLog.push(getCoreReadinessSnapshot()?.phase ?? 'null');
					if (readinessThrows) throw new Error('readiness check crashed');
					return readinessResult;
				})
			} as never
		};
	}

	it('emits applying -> starting -> checking -> ready phases on success', async () => {
		const { phaseLog, overrides } = makeOverrides({ readinessOk: true });

		await completeSetupOrchestration(
			{ completeSetup: () => ({ completed: true }) } as never,
			{ listAutomations: () => [] } as never,
			overrides
		);

		expect(phaseLog).toEqual(['applying', 'starting', 'checking']);
		const snapshot = getCoreReadinessSnapshot();
		expect(snapshot).not.toBeNull();
		expect(snapshot!.phase).toBe('ready');
	});

	it('emits applying -> starting -> checking -> failed when readiness not ok', async () => {
		const { phaseLog, overrides } = makeOverrides({ readinessOk: false });

		const result = await completeSetupOrchestration(
			{ completeSetup: () => ({ completed: true }) } as never,
			{ listAutomations: () => [] } as never,
			overrides
		);

		expect(phaseLog).toEqual(['applying', 'starting', 'checking']);
		const snapshot = getCoreReadinessSnapshot();
		expect(snapshot!.phase).toBe('failed');
		expect(snapshot!.diagnostics.failedServices.length).toBeGreaterThan(0);
		expect(result.readiness!.ok).toBeFalse();
	});

	it('emits applying -> starting -> failed when compose action fails', async () => {
		const { phaseLog, overrides } = makeOverrides({ composeOk: false });

		try {
			await completeSetupOrchestration(
				{ completeSetup: () => ({ completed: true }) } as never,
				{ listAutomations: () => [] } as never,
				overrides
			);
		} catch (error) {
			expect((error as Error).message).toContain('core_startup_failed');
		}

		expect(phaseLog).toEqual(['applying', 'starting']);
		const snapshot = getCoreReadinessSnapshot();
		expect(snapshot!.phase).toBe('failed');
	});

	it('sets phase to failed when ensureCoreServicesReady throws', async () => {
		const { phaseLog, overrides } = makeOverrides({ readinessThrows: true });

		const result = await completeSetupOrchestration(
			{ completeSetup: () => ({ completed: true }) } as never,
			{ listAutomations: () => [] } as never,
			overrides
		);

		expect(phaseLog).toEqual(['applying', 'starting', 'checking']);
		const snapshot = getCoreReadinessSnapshot();
		expect(snapshot!.phase).toBe('failed');
		expect(result.readiness).toBeUndefined();
	});

	it('setup still completes even when readiness check fails', async () => {
		const { overrides } = makeOverrides({ readinessOk: false });

		const result = await completeSetupOrchestration(
			{ completeSetup: () => ({ completed: true }) } as never,
			{ listAutomations: () => [] } as never,
			overrides
		);

		expect(result.state.completed).toBeTrue();
		expect(result.readiness).toBeDefined();
		expect(result.readiness!.ok).toBeFalse();
	});
});
