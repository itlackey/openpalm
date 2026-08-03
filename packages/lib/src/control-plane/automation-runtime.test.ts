import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutomationRuntimeComposeRunner } from './automation-runtime.js';
import {
	AutomationRuntimeError,
	deleteAutomationTaskFile,
	listAutomationTaskFiles,
	readAutomationTaskFile,
	readAutomationTaskLogs,
	writeAutomationTaskFile
} from './automation-runtime.js';
import type { DockerResult } from './docker.js';
import type { AutomationRuntimeResult } from './task-file-contract.js';
import {
	AUTOMATION_LOG_MAX_RESPONSE_BYTES,
	AUTOMATION_RUNTIME_SCHEMA_VERSION,
	AUTOMATION_RUNTIME_SHAPE,
	TASK_CONTENT_MAX_BYTES,
	TASK_FILE_MAX_VISIBLE
} from './task-file-contract.js';
import type { ControlPlaneState } from './types.js';

let homeDir = '';
let state: ControlPlaneState;

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), 'openpalm-runtime-client-'));
	const stackDir = join(homeDir, 'system', 'stack');
	mkdirSync(stackDir, { recursive: true });
	writeFileSync(join(stackDir, 'core.compose.yml'), 'services: {}\n');
	state = {
		homeDir,
		configDir: join(homeDir, 'config'),
		stashDir: join(homeDir, 'knowledge'),
		workspaceDir: join(homeDir, 'workspace'),
		dataDir: join(homeDir, 'data'),
		stackDir,
		services: {},
		artifacts: { compose: '' },
		artifactMeta: []
	};
});

afterEach(() => rmSync(homeDir, { recursive: true, force: true }));

function envelope(result: AutomationRuntimeResult): string {
	return JSON.stringify({
		shape: AUTOMATION_RUNTIME_SHAPE,
		schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
		ok: true,
		result
	});
}

function composeResult(stdout: string, overrides: Partial<DockerResult> = {}): DockerResult {
	return { ok: true, stdout, stderr: '', code: 0, ...overrides };
}

function runner(stdout: string): AutomationRuntimeComposeRunner {
	return mock(() => Promise.resolve(composeResult(stdout))) as AutomationRuntimeComposeRunner;
}

describe('automation runtime host client', () => {
	it('passes content through bounded stdin and runs a clean Node bundle under kernel flock', async () => {
		const content = 'opaque: value\n';
		const revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
		const runCompose = runner(envelope({ operation: 'write', fileName: 'daily.yml', revision }));

		await expect(
			writeAutomationTaskFile(state, 'daily.yml', content, null, runCompose)
		).resolves.toBe(revision);
		expect(runCompose).toHaveBeenCalledTimes(1);
		const [service, command, options] = (runCompose as ReturnType<typeof mock>).mock.calls[0] ?? [];
		expect(service).toBe('assistant');
		expect(command).not.toContain(content);
		expect(command).toEqual([
			'/usr/bin/setpriv',
			'--no-new-privs',
			'--',
			'/usr/bin/flock',
			'--exclusive',
			'--no-fork',
			'--timeout',
			'5',
			'--conflict-exit-code',
			'75',
			'/run/openpalm/user',
			'/usr/bin/timeout',
			'--signal=TERM',
			'--kill-after=2s',
			'10s',
			'/usr/bin/env',
			'-i',
			'HOME=/home/opencode',
			'USER=node',
			'LOGNAME=node',
			'PATH=/usr/local/bin:/usr/bin:/bin',
			'AKM_DATA_DIR=/opt/akm/data',
			'/usr/local/bin/node',
			'/usr/local/lib/openpalm/automation-runtime-helper.mjs'
		]);
		expect(command).not.toContain('/usr/local/bin/bun');
		expect(command.some((argument) => argument.endsWith('.ts'))).toBe(false);
		expect(options?.user).toBe('node');
		expect(options?.stdin?.maxBytes).toBeGreaterThan(TASK_CONTENT_MAX_BYTES);
		expect(JSON.parse(String(options?.stdin?.data))).toMatchObject({
			shape: AUTOMATION_RUNTIME_SHAPE,
			schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
			operation: 'write',
			fileName: 'daily.yml',
			content,
			expectedRevision: null
		});
	});

	it('strictly parses typed list/read/delete/log results', async () => {
		const content = 'opaque';
		const revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
		await expect(
			listAutomationTaskFiles(
				state,
				runner(
					envelope({
						operation: 'list',
						files: [
							{
								fileName: 'daily.yml',
								taskId: 'daily',
								size: Buffer.byteLength(content),
								revision,
								schedulable: true
							}
						]
					})
				)
			)
		).resolves.toHaveLength(1);
		await expect(
			readAutomationTaskFile(
				state,
				'daily.yml',
				runner(
					{
						toString: () =>
							envelope({ operation: 'read', fileName: 'daily.yml', content, revision })
					}.toString()
				)
			)
		).resolves.toEqual({ content, revision });
		await expect(
			deleteAutomationTaskFile(
				state,
				'daily.yml',
				revision,
				runner(envelope({ operation: 'delete', fileName: 'daily.yml' }))
			)
		).resolves.toBeUndefined();
		await expect(
			readAutomationTaskLogs(
				state,
				'daily.yml',
				20,
				runner(envelope({ operation: 'logs', fileName: 'daily.yml', lines: ['newest'] }))
			)
		).resolves.toEqual(['newest']);
	});

	it('rejects malformed, extra, inconsistent, and trailing response data', async () => {
		const content = 'opaque';
		const revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
		const badResponses = [
			'{}',
			`${envelope({ operation: 'read', fileName: 'daily.yml', content, revision })}\nextra`,
			JSON.stringify({
				shape: AUTOMATION_RUNTIME_SHAPE,
				schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
				ok: true,
				result: { operation: 'read', fileName: 'daily.yml', content, revision, extra: true }
			}),
			envelope({
				operation: 'read',
				fileName: 'daily.yml',
				content,
				revision: `sha256:${'0'.repeat(64)}`
			})
		];
		for (const stdout of badResponses) {
			await expect(
				readAutomationTaskFile(state, 'daily.yml', runner(stdout))
			).rejects.toMatchObject({
				code: 'invalid_response'
			});
		}
	});

	it('binds file results and write revisions to the original request', async () => {
		const content = 'opaque';
		const revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
		await expect(
			readAutomationTaskFile(
				state,
				'daily.yml',
				runner(envelope({ operation: 'read', fileName: 'other.yml', content, revision }))
			)
		).rejects.toMatchObject({ code: 'invalid_response' });

		await expect(
			writeAutomationTaskFile(
				state,
				'daily.yml',
				content,
				null,
				runner(
					envelope({
						operation: 'write',
						fileName: 'daily.yml',
						revision: `sha256:${'0'.repeat(64)}`
					})
				)
			)
		).rejects.toMatchObject({ code: 'invalid_response' });
	});

	it('rejects list and log responses beyond their protocol bounds', async () => {
		const revision = `sha256:${createHash('sha256').update('x').digest('hex')}`;
		const files = Array.from({ length: TASK_FILE_MAX_VISIBLE + 1 }, (_, index) => ({
			fileName: `task-${index}.yml`,
			taskId: `task-${index}`,
			size: 1,
			revision,
			schedulable: true
		}));
		await expect(
			listAutomationTaskFiles(state, runner(envelope({ operation: 'list', files })))
		).rejects.toMatchObject({ code: 'invalid_response' });

		await expect(
			readAutomationTaskLogs(
				state,
				'daily.yml',
				1,
				runner(envelope({ operation: 'logs', fileName: 'daily.yml', lines: ['one', 'two'] }))
			)
		).rejects.toMatchObject({ code: 'invalid_response' });

		await expect(
			readAutomationTaskLogs(
				state,
				'daily.yml',
				1,
				runner(
					envelope({
						operation: 'logs',
						fileName: 'daily.yml',
						lines: ['x'.repeat(AUTOMATION_LOG_MAX_RESPONSE_BYTES)]
					})
				)
			)
		).rejects.toMatchObject({ code: 'invalid_response' });
	});

	it('preserves helper conflict codes, maps flock timeout to busy, and maps other failures to unavailable', async () => {
		const conflict = runner(
			JSON.stringify({
				shape: AUTOMATION_RUNTIME_SHAPE,
				schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
				ok: false,
				error: { code: 'conflict', message: 'newer content exists' }
			})
		);
		await expect(
			writeAutomationTaskFile(state, 'daily.yml', 'new', `sha256:${'0'.repeat(64)}`, conflict)
		).rejects.toEqual(new AutomationRuntimeError('conflict', 'newer content exists'));

		const busy = mock(() =>
			Promise.resolve(composeResult('', { ok: false, stderr: '', code: 75 }))
		) as AutomationRuntimeComposeRunner;
		await expect(listAutomationTaskFiles(state, busy)).rejects.toEqual(
			new AutomationRuntimeError('busy', 'Timed out waiting for the automation runtime lock')
		);

		const unavailable = mock(() =>
			Promise.resolve(composeResult('', { ok: false, stderr: 'assistant is not running', code: 1 }))
		) as AutomationRuntimeComposeRunner;
		await expect(listAutomationTaskFiles(state, unavailable)).rejects.toMatchObject({
			code: 'unavailable',
			message: 'assistant is not running'
		});
	});

	it('rejects oversized content before invoking Compose', async () => {
		const runCompose = runner('');
		await expect(
			writeAutomationTaskFile(
				state,
				'daily.yml',
				'x'.repeat(TASK_CONTENT_MAX_BYTES + 1),
				null,
				runCompose
			)
		).rejects.toMatchObject({ code: 'too_large' });
		expect(runCompose).not.toHaveBeenCalled();
	});

	it('rejects ill-formed Unicode and format-control filenames before invoking Compose', async () => {
		for (const [fileName, message] of [
			[`bad-\ud800.yml`, 'well-formed Unicode'],
			['invoice\u202ereversed.yml', 'bidirectional control']
		] as const) {
			const runCompose = runner('');
			await expect(readAutomationTaskFile(state, fileName, runCompose)).rejects.toThrow(message);
			await expect(
				writeAutomationTaskFile(state, fileName, 'opaque', null, runCompose)
			).rejects.toThrow(message);
			await expect(
				deleteAutomationTaskFile(state, fileName, `sha256:${'0'.repeat(64)}`, runCompose)
			).rejects.toThrow(message);
			await expect(readAutomationTaskLogs(state, fileName, 10, runCompose)).rejects.toThrow(
				message
			);
			expect(runCompose).not.toHaveBeenCalled();
		}
	});
});
