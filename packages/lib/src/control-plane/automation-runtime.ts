import { createHash } from 'node:crypto';
import { buildComposeOptions } from './compose-args.js';
import { composeExec } from './docker.js';
import type {
	AutomationRuntimeErrorCode,
	AutomationRuntimeRequest,
	AutomationRuntimeResult,
	AutomationTaskFileInfo,
	TaskFileSnapshot
} from './task-file-contract.js';
import {
	AUTOMATION_LOG_MAX_RESPONSE_BYTES,
	AUTOMATION_RUNTIME_MAX_STDIN_BYTES,
	AUTOMATION_RUNTIME_MAX_STDOUT_BYTES,
	AUTOMATION_RUNTIME_SCHEMA_VERSION,
	AUTOMATION_RUNTIME_SHAPE,
	assertPortableTaskFilename,
	assertSchedulableTaskFilename,
	assertTaskRevision,
	isSchedulableTaskFilename,
	TASK_CONTENT_MAX_BYTES,
	TASK_FILE_MAX_VISIBLE,
	taskIdFromTaskFilename
} from './task-file-contract.js';
import type { ControlPlaneState } from './types.js';

const AUTOMATION_RUNTIME_HELPER = '/usr/local/lib/openpalm/automation-runtime-helper.mjs';
const AUTOMATION_RUNTIME_BUSY_EXIT_CODE = 75;
const AUTOMATION_RUNTIME_TIMEOUT_MS = 20_000;
const AUTOMATION_RUNTIME_COMMAND = [
	'/usr/bin/setpriv',
	'--no-new-privs',
	'--',
	'/usr/bin/flock',
	'--exclusive',
	'--no-fork',
	'--timeout',
	'5',
	'--conflict-exit-code',
	String(AUTOMATION_RUNTIME_BUSY_EXIT_CODE),
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
	AUTOMATION_RUNTIME_HELPER
];

const ERROR_CODES = new Set<AutomationRuntimeErrorCode>([
	'busy',
	'conflict',
	'invalid_name',
	'invalid_request',
	'invalid_response',
	'invalid_task_id',
	'io_error',
	'not_found',
	'too_large',
	'unavailable',
	'unsafe_file'
]);

export class AutomationRuntimeError extends Error {
	constructor(
		readonly code: AutomationRuntimeErrorCode,
		message: string
	) {
		super(message);
		this.name = 'AutomationRuntimeError';
	}
}

export type AutomationRuntimeComposeRunner = typeof composeExec;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidResponse(message: string): never {
	throw new AutomationRuntimeError(
		'invalid_response',
		`Invalid automation runtime response: ${message}`
	);
}

function validateFileName(fileName: string, schedulable = false): void {
	try {
		if (schedulable) assertSchedulableTaskFilename(fileName);
		else assertPortableTaskFilename(fileName);
	} catch (error) {
		throw new AutomationRuntimeError(
			schedulable ? 'invalid_task_id' : 'invalid_name',
			error instanceof Error ? error.message : String(error)
		);
	}
}

function validateRevision(revision: string): void {
	try {
		assertTaskRevision(revision);
	} catch (error) {
		throw new AutomationRuntimeError(
			'invalid_request',
			error instanceof Error ? error.message : String(error)
		);
	}
}

function parseTaskFileInfo(value: unknown): AutomationTaskFileInfo {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ['fileName', 'taskId', 'size', 'revision', 'schedulable'])
	) {
		invalidResponse('invalid task file metadata');
	}
	if (
		typeof value.fileName !== 'string' ||
		typeof value.taskId !== 'string' ||
		typeof value.size !== 'number' ||
		!Number.isSafeInteger(value.size) ||
		value.size < 0 ||
		value.size > TASK_CONTENT_MAX_BYTES ||
		typeof value.revision !== 'string' ||
		typeof value.schedulable !== 'boolean'
	) {
		invalidResponse('invalid task file metadata fields');
	}
	try {
		assertPortableTaskFilename(value.fileName);
		assertTaskRevision(value.revision);
	} catch (error) {
		invalidResponse(error instanceof Error ? error.message : String(error));
	}
	if (
		value.taskId !== taskIdFromTaskFilename(value.fileName) ||
		value.schedulable !== isSchedulableTaskFilename(value.fileName)
	) {
		invalidResponse('inconsistent task file metadata');
	}
	return value as AutomationTaskFileInfo;
}

function parseResult(value: unknown, request: AutomationRuntimeRequest): AutomationRuntimeResult {
	if (!isRecord(value) || value.operation !== request.operation) {
		invalidResponse('operation does not match request');
	}
	switch (request.operation) {
		case 'list': {
			if (
				!hasExactKeys(value, ['operation', 'files']) ||
				!Array.isArray(value.files) ||
				value.files.length > TASK_FILE_MAX_VISIBLE
			) {
				invalidResponse('invalid list result');
			}
			const files = value.files.map(parseTaskFileInfo);
			if (new Set(files.map((file) => file.fileName)).size !== files.length) {
				invalidResponse('duplicate task file metadata');
			}
			return { operation: 'list', files };
		}
		case 'read': {
			if (
				!hasExactKeys(value, ['operation', 'fileName', 'content', 'revision']) ||
				typeof value.fileName !== 'string' ||
				typeof value.content !== 'string' ||
				typeof value.revision !== 'string'
			) {
				invalidResponse('invalid read result');
			}
			if (value.fileName !== request.fileName) invalidResponse('file name does not match request');
			try {
				assertPortableTaskFilename(value.fileName);
				assertTaskRevision(value.revision);
			} catch (error) {
				invalidResponse(error instanceof Error ? error.message : String(error));
			}
			const bytes = Buffer.from(value.content, 'utf8');
			if (bytes.byteLength > TASK_CONTENT_MAX_BYTES || bytes.toString('utf8') !== value.content) {
				invalidResponse('invalid task content');
			}
			const revision = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
			if (revision !== value.revision) invalidResponse('task content revision does not match');
			return value as AutomationRuntimeResult;
		}
		case 'write': {
			if (
				!hasExactKeys(value, ['operation', 'fileName', 'revision']) ||
				typeof value.fileName !== 'string' ||
				typeof value.revision !== 'string'
			) {
				invalidResponse('invalid write result');
			}
			if (value.fileName !== request.fileName) invalidResponse('file name does not match request');
			try {
				assertPortableTaskFilename(value.fileName);
				assertTaskRevision(value.revision);
			} catch (error) {
				invalidResponse(error instanceof Error ? error.message : String(error));
			}
			const expectedRevision = `sha256:${createHash('sha256').update(request.content, 'utf8').digest('hex')}`;
			if (value.revision !== expectedRevision)
				invalidResponse('written content revision does not match');
			return value as AutomationRuntimeResult;
		}
		case 'delete': {
			if (!hasExactKeys(value, ['operation', 'fileName']) || typeof value.fileName !== 'string') {
				invalidResponse('invalid delete result');
			}
			if (value.fileName !== request.fileName) invalidResponse('file name does not match request');
			try {
				assertPortableTaskFilename(value.fileName);
			} catch (error) {
				invalidResponse(error instanceof Error ? error.message : String(error));
			}
			return value as AutomationRuntimeResult;
		}
		case 'logs': {
			if (
				!hasExactKeys(value, ['operation', 'fileName', 'lines']) ||
				typeof value.fileName !== 'string' ||
				!Array.isArray(value.lines) ||
				value.lines.some((line) => typeof line !== 'string')
			) {
				invalidResponse('invalid logs result');
			}
			if (value.fileName !== request.fileName) invalidResponse('file name does not match request');
			if (value.lines.length > request.limit)
				invalidResponse('log line count exceeds request limit');
			try {
				assertSchedulableTaskFilename(value.fileName);
			} catch (error) {
				invalidResponse(error instanceof Error ? error.message : String(error));
			}
			return value as AutomationRuntimeResult;
		}
	}
}

function parseEnvelope(stdout: string, request: AutomationRuntimeRequest): AutomationRuntimeResult {
	if (
		request.operation === 'logs' &&
		Buffer.byteLength(stdout, 'utf8') > AUTOMATION_LOG_MAX_RESPONSE_BYTES
	) {
		invalidResponse('log response exceeds byte limit');
	}
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		invalidResponse('stdout is not one JSON value');
	}
	if (!isRecord(value)) invalidResponse('envelope must be an object');
	if (
		value.shape !== AUTOMATION_RUNTIME_SHAPE ||
		value.schemaVersion !== AUTOMATION_RUNTIME_SCHEMA_VERSION
	) {
		invalidResponse('unsupported envelope');
	}
	if (value.ok === false) {
		if (!hasExactKeys(value, ['shape', 'schemaVersion', 'ok', 'error']) || !isRecord(value.error)) {
			invalidResponse('invalid error envelope');
		}
		if (
			!hasExactKeys(value.error, ['code', 'message']) ||
			typeof value.error.code !== 'string' ||
			!ERROR_CODES.has(value.error.code as AutomationRuntimeErrorCode) ||
			typeof value.error.message !== 'string' ||
			value.error.message.length === 0
		) {
			invalidResponse('invalid error fields');
		}
		throw new AutomationRuntimeError(
			value.error.code as AutomationRuntimeErrorCode,
			value.error.message
		);
	}
	if (value.ok !== true || !hasExactKeys(value, ['shape', 'schemaVersion', 'ok', 'result'])) {
		invalidResponse('invalid success envelope');
	}
	return parseResult(value.result, request);
}

function runtimeRequest<T extends Omit<AutomationRuntimeRequest, 'shape' | 'schemaVersion'>>(
	request: T
): AutomationRuntimeRequest {
	return {
		shape: AUTOMATION_RUNTIME_SHAPE,
		schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
		...request
	} as AutomationRuntimeRequest;
}

function failureDetail(result: Awaited<ReturnType<typeof composeExec>>): string {
	return (
		result.stderr.trim() ||
		result.stdout.trim() ||
		(result.errorCode ? `Docker execution failed (${result.errorCode})` : '') ||
		`docker compose exec exited ${result.code}`
	);
}

export async function runAutomationRuntime(
	state: ControlPlaneState,
	request: AutomationRuntimeRequest,
	runCompose: AutomationRuntimeComposeRunner = composeExec
): Promise<AutomationRuntimeResult> {
	const input = JSON.stringify(request);
	const inputBytes = Buffer.byteLength(input);
	if (inputBytes > AUTOMATION_RUNTIME_MAX_STDIN_BYTES) {
		throw new AutomationRuntimeError('too_large', 'Automation runtime request is too large');
	}

	let result: Awaited<ReturnType<typeof composeExec>>;
	try {
		result = await runCompose('assistant', AUTOMATION_RUNTIME_COMMAND, {
			...buildComposeOptions(state),
			timeoutMs: AUTOMATION_RUNTIME_TIMEOUT_MS,
			user: 'node',
			stdin: { data: input, maxBytes: AUTOMATION_RUNTIME_MAX_STDIN_BYTES },
			maxOutputBytes: AUTOMATION_RUNTIME_MAX_STDOUT_BYTES
		});
	} catch (error) {
		throw new AutomationRuntimeError(
			'unavailable',
			error instanceof Error ? error.message : String(error)
		);
	}
	if (!result.ok) {
		if (result.code === AUTOMATION_RUNTIME_BUSY_EXIT_CODE) {
			throw new AutomationRuntimeError('busy', 'Timed out waiting for the automation runtime lock');
		}
		throw new AutomationRuntimeError('unavailable', failureDetail(result));
	}
	return parseEnvelope(result.stdout, request);
}

export async function listAutomationTaskFiles(
	state: ControlPlaneState,
	runCompose: AutomationRuntimeComposeRunner = composeExec
): Promise<AutomationTaskFileInfo[]> {
	const result = await runAutomationRuntime(
		state,
		runtimeRequest({ operation: 'list' }),
		runCompose
	);
	if (result.operation !== 'list') invalidResponse('expected list result');
	return result.files;
}

export async function readAutomationTaskFile(
	state: ControlPlaneState,
	fileName: string,
	runCompose: AutomationRuntimeComposeRunner = composeExec
): Promise<TaskFileSnapshot> {
	validateFileName(fileName);
	const result = await runAutomationRuntime(
		state,
		runtimeRequest({ operation: 'read', fileName }),
		runCompose
	);
	if (result.operation !== 'read') invalidResponse('expected read result');
	return { content: result.content, revision: result.revision };
}

export async function writeAutomationTaskFile(
	state: ControlPlaneState,
	fileName: string,
	content: string,
	expectedRevision: string | null,
	runCompose: AutomationRuntimeComposeRunner = composeExec
): Promise<string> {
	validateFileName(fileName, expectedRevision === null);
	if (expectedRevision !== null) validateRevision(expectedRevision);
	if (Buffer.byteLength(content, 'utf8') > TASK_CONTENT_MAX_BYTES) {
		throw new AutomationRuntimeError(
			'too_large',
			`Task content exceeds ${TASK_CONTENT_MAX_BYTES} bytes`
		);
	}
	const result = await runAutomationRuntime(
		state,
		runtimeRequest({ operation: 'write', fileName, content, expectedRevision }),
		runCompose
	);
	if (result.operation !== 'write') invalidResponse('expected write result');
	return result.revision;
}

export async function deleteAutomationTaskFile(
	state: ControlPlaneState,
	fileName: string,
	expectedRevision: string,
	runCompose: AutomationRuntimeComposeRunner = composeExec
): Promise<void> {
	validateFileName(fileName);
	validateRevision(expectedRevision);
	const result = await runAutomationRuntime(
		state,
		runtimeRequest({ operation: 'delete', fileName, expectedRevision }),
		runCompose
	);
	if (result.operation !== 'delete') invalidResponse('expected delete result');
}

export async function readAutomationTaskLogs(
	state: ControlPlaneState,
	fileName: string,
	limit: number,
	runCompose: AutomationRuntimeComposeRunner = composeExec
): Promise<string[]> {
	validateFileName(fileName, true);
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new AutomationRuntimeError(
			'invalid_request',
			'Log limit must be an integer from 1 to 500'
		);
	}
	const result = await runAutomationRuntime(
		state,
		runtimeRequest({ operation: 'logs', fileName, limit }),
		runCompose
	);
	if (result.operation !== 'logs') invalidResponse('expected logs result');
	return result.lines;
}

export type { AutomationTaskFileInfo, TaskFileSnapshot };
