import { describe, expect, it, mock } from 'bun:test';
import { CoreServices, SetupStartupServices } from '@openpalm/lib/admin/compose-runner';
import { completeSetupOrchestration } from './setup-completion';

describe('setup-completion orchestrator', () => {
	it('uses canonical startup services derived from compose core services', () => {
		expect(SetupStartupServices).toEqual(CoreServices.filter((service) => service !== 'admin'));
		expect(SetupStartupServices).not.toContain('admin');
	});

	it('writes POSTGRES_PASSWORD when missing before stack apply', async () => {
		const applyResult = { ok: true, generated: {}, warnings: [] } as never;
		const existsSyncMock = mock(() => false);
		const readFileSyncMock = mock(() => '');
		const parseRuntimeEnvContentMock = mock(() => ({}));
		const updateRuntimeEnvContentMock = mock(() => 'POSTGRES_PASSWORD=generated-token\n');
		const generateTokenMock = mock(() => 'generated-token');
		const mkdirSyncMock = mock(() => undefined);
		const dirnameMock = mock(() => '/tmp/config');
		const writeFileSyncMock = mock(() => undefined);
		const applyStackMock = mock(async () => applyResult);
		const composeActionMock = mock(async () => ({ ok: true, stdout: '', stderr: '' }));
		const syncAutomationsMock = mock(() => undefined);
		const completeSetupMock = mock(() => ({ completed: true }));
		const listAutomationsMock = mock(() => [{ id: 'auto-1' }]);

		const result = await completeSetupOrchestration(
			{ completeSetup: completeSetupMock } as never,
			{ listAutomations: listAutomationsMock } as never,
			({
				secretsEnvPath: '/tmp/config/secrets.env',
				existsSync: existsSyncMock,
				readFileSync: readFileSyncMock,
				parseRuntimeEnvContent: parseRuntimeEnvContentMock,
				updateRuntimeEnvContent: updateRuntimeEnvContentMock,
				generateToken: generateTokenMock,
				mkdirSync: mkdirSyncMock,
				dirname: dirnameMock,
				writeFileSync: writeFileSyncMock,
				applyStack: applyStackMock,
				composeAction: composeActionMock,
				syncAutomations: syncAutomationsMock
			} as never)
		);

		expect(generateTokenMock).toHaveBeenCalledWith(32);
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		expect(applyStackMock).toHaveBeenCalledTimes(1);
		expect(composeActionMock).toHaveBeenCalledTimes(1);
		expect(composeActionMock).toHaveBeenCalledWith('up', [...SetupStartupServices]);
		expect(syncAutomationsMock).toHaveBeenCalledTimes(1);
		expect(completeSetupMock).toHaveBeenCalledTimes(1);
		expect(result.apply).toBe(applyResult);
		expect(result.state.completed).toBeTrue();
	});

	it('skips POSTGRES_PASSWORD write when already configured', async () => {
		const writeFileSyncMock = mock(() => undefined);

		await completeSetupOrchestration(
			{ completeSetup: () => ({ completed: true }) } as never,
			{ listAutomations: () => [] } as never,
			({
				secretsEnvPath: '/tmp/config/secrets.env',
				existsSync: () => true,
				readFileSync: () => 'POSTGRES_PASSWORD=already-set\n',
				parseRuntimeEnvContent: () => ({ POSTGRES_PASSWORD: 'already-set' }),
				updateRuntimeEnvContent: () => 'unused',
				generateToken: () => 'unused',
				mkdirSync: () => undefined,
				dirname: () => '/tmp/config',
				writeFileSync: writeFileSyncMock,
				applyStack: async () => ({ ok: true }),
				composeAction: async () => ({ ok: true, stdout: '', stderr: '' }),
				syncAutomations: () => undefined
			} as never)
		);

		expect(writeFileSyncMock).not.toHaveBeenCalled();
	});

	it('throws when startup compose action fails', async () => {
		expect(
			completeSetupOrchestration(
				{ completeSetup: () => ({ completed: true }) } as never,
				{ listAutomations: () => [] } as never,
				({
					secretsEnvPath: '/tmp/config/secrets.env',
					existsSync: () => true,
					readFileSync: () => 'POSTGRES_PASSWORD=already-set\n',
					parseRuntimeEnvContent: () => ({ POSTGRES_PASSWORD: 'already-set' }),
					updateRuntimeEnvContent: () => 'unused',
					generateToken: () => 'unused',
					mkdirSync: () => undefined,
					dirname: () => '/tmp/config',
					writeFileSync: () => undefined,
					applyStack: async () => ({ ok: true }),
					composeAction: async () => ({ ok: false, stdout: '', stderr: 'compose failed' }),
					syncAutomations: () => undefined
				} as never)
			)
		).rejects.toThrow('core_startup_failed:compose failed');
	});
});
