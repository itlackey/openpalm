import { describe, expect, it, mock } from 'bun:test';
import { completeSetupCommandResponse, completeSetupRouteResponse } from './setup-completion-response';

describe('setup completion response helpers', () => {
	it('builds command response and calls orchestrator once', async () => {
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
});
