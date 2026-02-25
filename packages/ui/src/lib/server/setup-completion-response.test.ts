import { describe, expect, it, mock } from 'bun:test';

async function loadResponseHelpers() {
	mock.module('./setup-completion', () => ({
		completeSetupOrchestration: mock(async () => ({
			state: { completed: true },
			apply: { ok: true, generated: {}, warnings: [] }
		}))
	}));
	return import('./setup-completion-response');
}

describe('setup completion response helpers', () => {
	it('builds command response and calls orchestrator once', async () => {
		const { completeSetupCommandResponse } = await loadResponseHelpers();
		const secretsEnvPath = '/tmp/config/secrets.env';
		const completeSetup = mock(async () => ({
			state: { completed: true },
			apply: { ok: true, generated: {}, warnings: [] }
		}));

		const result = await completeSetupCommandResponse(
			{} as never,
			{} as never,
			secretsEnvPath,
			completeSetup as never
		);

		expect(completeSetup).toHaveBeenCalledTimes(1);
		expect(completeSetup).toHaveBeenCalledWith({} as never, {} as never, { secretsEnvPath });
		expect(result.ok).toBeTrue();
		expect(result.data.completed).toBeTrue();
		expect(result.apply.ok).toBeTrue();
	});

	it('builds setup route response and calls orchestrator once', async () => {
		const { completeSetupRouteResponse } = await loadResponseHelpers();
		const secretsEnvPath = '/tmp/config/secrets.env';
		const completeSetup = mock(async () => ({
			state: { completed: true },
			apply: { ok: true, generated: {}, warnings: [] }
		}));

		const result = await completeSetupRouteResponse(
			{} as never,
			{} as never,
			secretsEnvPath,
			completeSetup as never
		);

		expect(completeSetup).toHaveBeenCalledTimes(1);
		expect(completeSetup).toHaveBeenCalledWith({} as never, {} as never, { secretsEnvPath });
		expect(result.ok).toBeTrue();
		expect(result.state.completed).toBeTrue();
		expect(result.apply.ok).toBeTrue();
	});

	it('uses the same orchestration contract for both endpoint response helpers', async () => {
		const { completeSetupCommandResponse, completeSetupRouteResponse } = await loadResponseHelpers();
		const setupManager = { id: 'setup' } as never;
		const stackManager = { id: 'stack' } as never;
		const secretsEnvPath = '/tmp/openpalm/secrets.env';
		const completeSetup = mock(async () => ({
			state: { completed: true },
			apply: { ok: true, generated: {}, warnings: [] }
		}));

		await completeSetupCommandResponse(setupManager, stackManager, secretsEnvPath, completeSetup as never);
		await completeSetupRouteResponse(setupManager, stackManager, secretsEnvPath, completeSetup as never);

		expect(completeSetup).toHaveBeenCalledTimes(2);
		expect(completeSetup).toHaveBeenNthCalledWith(1, setupManager, stackManager, { secretsEnvPath });
		expect(completeSetup).toHaveBeenNthCalledWith(2, setupManager, stackManager, { secretsEnvPath });
	});
});
