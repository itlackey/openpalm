import { describe, expect, mock, test } from 'bun:test';
import { runAssistantAkmCommand } from './assistant-akm.js';
import type { composeExec } from './docker.js';
import type { ControlPlaneState } from './types.js';

describe('runAssistantAkmCommand', () => {
	test('uses the immutable AKM launcher as node without privilege gains', async () => {
		const state = {
			homeDir: '/openpalm',
			configDir: '/openpalm/config',
			stashDir: '/openpalm/knowledge',
			dataDir: '/openpalm/data',
			workspaceDir: '/openpalm/workspace',
			stackDir: '/openpalm/system/stack'
		} as ControlPlaneState;
		const runCompose = mock((() =>
			Promise.resolve({ ok: true, stdout: '{}', stderr: '', code: 0 })) as typeof composeExec);

		await runAssistantAkmCommand(state, ['task', 'run', 'daily'], 1234, {}, runCompose);

		expect(runCompose).toHaveBeenCalledTimes(1);
		const [service, command, options] = runCompose.mock.calls[0] ?? [];
		expect(service).toBe('assistant');
		expect(command).toEqual([
			'/usr/bin/setpriv',
			'--no-new-privs',
			'--',
			'/usr/bin/env',
			expect.stringMatching(/^PATH=\/opt\/openpalm\/tools\/node_modules\/\.bin:\/usr\/local\/bin:/),
			'/usr/local/bin/akm',
			'task',
			'run',
			'daily'
		]);
		expect(options?.timeoutMs).toBe(1234);
		expect(options?.user).toBe('node');
	});

	test('gives only task doctor the crontab supplementary group', async () => {
		const state = {
			homeDir: '/openpalm',
			stackDir: '/openpalm/system/stack'
		} as ControlPlaneState;
		const runCompose = mock(((_service: string, command: string[]) =>
			Promise.resolve({
				ok: true,
				stdout: command[0] === '/usr/bin/id' ? '100\n' : '{}',
				stderr: '',
				code: 0
			})) as typeof composeExec);

		await runAssistantAkmCommand(
			state,
			['task', 'doctor', '--format', 'json'],
			1234,
			{},
			runCompose
		);

		expect(runCompose).toHaveBeenCalledTimes(2);
		expect(runCompose.mock.calls[0]?.[1]).toEqual(['/usr/bin/id', '-g', 'node']);
		expect(runCompose.mock.calls[0]?.[2]?.user).toBe('root');
		const command = runCompose.mock.calls[1]?.[1];
		expect(command).toEqual([
			'/usr/bin/setpriv',
			'--reuid=node',
			'--regid=100',
			'--groups=crontab',
			'--bounding-set=-all',
			'--inh-caps=-all',
			'--ambient-caps=-all',
			'--no-new-privs',
			'--',
			'/usr/bin/env',
			expect.stringMatching(/^PATH=\/opt\/openpalm\/tools\/node_modules\/\.bin:\/usr\/local\/bin:/),
			'/usr/local/bin/akm',
			'task',
			'doctor',
			'--format',
			'json'
		]);
		expect(runCompose.mock.calls[1]?.[2]?.user).toBe('root');
	});

	test('fails closed when the node primary GID probe is malformed', async () => {
		const state = {
			homeDir: '/openpalm',
			stackDir: '/openpalm/system/stack'
		} as ControlPlaneState;
		const runCompose = mock((() =>
			Promise.resolve({ ok: true, stdout: 'node\n', stderr: '', code: 0 })) as typeof composeExec);

		await expect(
			runAssistantAkmCommand(state, ['task', 'doctor'], 1234, {}, runCompose)
		).resolves.toMatchObject({
			ok: false,
			stderr: 'Assistant node account has an invalid primary GID.'
		});
		expect(runCompose).toHaveBeenCalledTimes(1);
	});

	test('normalizes compose runner rejections', async () => {
		const state = {
			homeDir: '/openpalm',
			stackDir: '/openpalm/system/stack'
		} as ControlPlaneState;
		const runCompose = mock((() =>
			Promise.reject(new Error('compose unavailable'))) as typeof composeExec);

		await expect(
			runAssistantAkmCommand(state, ['health'], 1234, {}, runCompose)
		).resolves.toMatchObject({
			ok: false,
			stderr: 'compose unavailable',
			exitCode: 1
		});
	});

	test('preserves resolved Docker spawn failures without misreporting AKM as missing', async () => {
		const state = {
			homeDir: '/openpalm',
			stackDir: '/openpalm/system/stack'
		} as ControlPlaneState;
		const runCompose = mock((() =>
			Promise.resolve({
				ok: false,
				stdout: '',
				stderr: '',
				code: 1,
				errorCode: 'ENOENT'
			})) as typeof composeExec);

		await expect(
			runAssistantAkmCommand(state, ['health'], 1234, {}, runCompose)
		).resolves.toMatchObject({
			ok: false,
			stderr: 'Docker execution failed (ENOENT)',
			missing: false
		});
	});
});
