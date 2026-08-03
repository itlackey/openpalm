import * as childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
	AutomationRuntimeEnvelope,
	AutomationRuntimeErrorCode,
	AutomationRuntimeRequest,
	AutomationRuntimeResult,
	AutomationTaskFileInfo,
	TaskFileSnapshot
} from './task-file-contract.js';
import {
	AUTOMATION_LOG_MAX_AGGREGATE_READ_BYTES,
	AUTOMATION_LOG_MAX_RESPONSE_BYTES,
	AUTOMATION_RUNTIME_MAX_DIRECTORY_ENTRIES,
	AUTOMATION_RUNTIME_MAX_STDIN_BYTES,
	AUTOMATION_RUNTIME_MAX_STDOUT_BYTES,
	AUTOMATION_RUNTIME_SCHEMA_VERSION,
	AUTOMATION_RUNTIME_SHAPE,
	assertPortableTaskFilename,
	assertSchedulableTaskFilename,
	assertTaskRevision,
	isSchedulableTaskFilename,
	portableTaskFilenameError,
	schedulableTaskFilenameError,
	TASK_CONTENT_MAX_BYTES,
	TASK_FILE_MAX_VISIBLE,
	taskIdFromTaskFilename
} from './task-file-contract.js';

const TASKS_DIRECTORY_NAME = 'tasks';
const SQLITE_PATH = '/usr/bin/sqlite3';

export type AutomationRuntimePaths = {
	stashDir: string;
	dataDir: string;
};

type OpenDirectory = {
	descriptor: number;
	anchor: string;
	canonicalPath: string;
	identity: BigIntStats;
};

type InternalTaskSnapshot = TaskFileSnapshot & {
	size: number;
	stats: BigIntStats;
};

type StagedTaskFile = {
	name: string;
	descriptor: number;
	stats: BigIntStats;
};

class RuntimeFailure extends Error {
	constructor(
		readonly code: AutomationRuntimeErrorCode,
		message: string
	) {
		super(message);
		this.name = 'RuntimeFailure';
	}
}

function defaultPaths(): AutomationRuntimePaths {
	return {
		stashDir: '/stash',
		dataDir: process.env.AKM_DATA_DIR || '/opt/akm/data'
	};
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		codes.includes(String((error as { code?: unknown }).code))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requiredFlag(name: 'O_DIRECTORY' | 'O_NOFOLLOW' | 'O_NONBLOCK'): number {
	const flag = fs.constants[name];
	if (typeof flag !== 'number' || flag === 0) {
		throw new RuntimeFailure(
			'unavailable',
			`Required Linux filesystem flag is unavailable: ${name}`
		);
	}
	return flag;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return (
		sameFile(left, right) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function isSinglyLinkedRegularFile(stats: BigIntStats): boolean {
	return !stats.isSymbolicLink() && stats.isFile() && stats.nlink === 1n;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function lstatPath(path: string): BigIntStats | null {
	try {
		return fs.lstatSync(path, { bigint: true });
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return null;
		throw error;
	}
}

function lstatAt(directory: OpenDirectory, name: string): BigIntStats | null {
	return lstatPath(join(directory.anchor, name));
}

function verifyDirectoryAnchor(directory: OpenDirectory): void {
	const descriptorStats = fs.fstatSync(directory.descriptor, { bigint: true });
	const anchorStats = fs.statSync(directory.anchor, { bigint: true });
	if (
		!descriptorStats.isDirectory() ||
		!anchorStats.isDirectory() ||
		!sameFile(directory.identity, descriptorStats) ||
		!sameFile(descriptorStats, anchorStats)
	) {
		throw new RuntimeFailure('unsafe_file', 'Directory descriptor anchor is unavailable or changed');
	}
}

function verifyCanonicalDirectory(directory: OpenDirectory): void {
	verifyDirectoryAnchor(directory);
	const named = lstatPath(directory.canonicalPath);
	if (named === null || !named.isDirectory() || !sameFile(directory.identity, named)) {
		throw new RuntimeFailure(
			'unsafe_file',
			`Directory pathname no longer names the opened directory: ${directory.canonicalPath}`
		);
	}

	let descriptor: number;
	try {
		descriptor = fs.openSync(
			directory.canonicalPath,
			fs.constants.O_RDONLY | requiredFlag('O_DIRECTORY') | requiredFlag('O_NOFOLLOW')
		);
	} catch {
		throw new RuntimeFailure(
			'unsafe_file',
			`Directory pathname is no longer safe: ${directory.canonicalPath}`
		);
	}
	try {
		const reopened = fs.fstatSync(descriptor, { bigint: true });
		if (!reopened.isDirectory() || !sameFile(directory.identity, reopened)) {
			throw new RuntimeFailure(
				'unsafe_file',
				`Directory pathname changed while being verified: ${directory.canonicalPath}`
			);
		}
	} finally {
		fs.closeSync(descriptor);
	}
}

function openDirectory(
	openPath: string,
	canonicalPath = openPath,
	missingIsEmpty = false
): OpenDirectory | null {
	let descriptor: number;
	try {
		descriptor = fs.openSync(
			openPath,
			fs.constants.O_RDONLY | requiredFlag('O_DIRECTORY') | requiredFlag('O_NOFOLLOW')
		);
	} catch (error) {
		if (missingIsEmpty && hasErrorCode(error, 'ENOENT')) return null;
		if (hasErrorCode(error, 'ELOOP', 'ENOTDIR')) {
			throw new RuntimeFailure('unsafe_file', `Directory is not a real directory: ${canonicalPath}`);
		}
		throw error;
	}

	const directory: OpenDirectory = {
		descriptor,
		anchor: join('/proc/self/fd', String(descriptor)),
		canonicalPath,
		identity: fs.fstatSync(descriptor, { bigint: true })
	};
	try {
		verifyCanonicalDirectory(directory);
		return directory;
	} catch (error) {
		fs.closeSync(descriptor);
		throw error;
	}
}

function openChildDirectory(
	parent: OpenDirectory,
	name: string,
	missingIsEmpty = false
): OpenDirectory | null {
	verifyCanonicalDirectory(parent);
	return openDirectory(
		join(parent.anchor, name),
		join(parent.canonicalPath, name),
		missingIsEmpty
	);
}

function closeDirectory(directory: OpenDirectory | null): void {
	if (directory !== null) fs.closeSync(directory.descriptor);
}

function openTasksDirectory(paths: AutomationRuntimePaths, create: boolean): OpenDirectory | null {
	const stashPath = resolve(paths.stashDir);
	const stash = openDirectory(stashPath, stashPath);
	if (stash === null) throw new RuntimeFailure('unavailable', 'The assistant stash is unavailable');
	try {
		let tasks = openChildDirectory(stash, TASKS_DIRECTORY_NAME, true);
		if (tasks === null && create) {
			try {
				fs.mkdirSync(join(stash.anchor, TASKS_DIRECTORY_NAME), { mode: 0o755 });
				fs.fsyncSync(stash.descriptor);
			} catch (error) {
				if (!hasErrorCode(error, 'EEXIST')) throw error;
			}
			tasks = openChildDirectory(stash, TASKS_DIRECTORY_NAME);
		}
		return tasks;
	} finally {
		closeDirectory(stash);
	}
}

function withTasks<T>(
	paths: AutomationRuntimePaths,
	create: boolean,
	operation: (directory: OpenDirectory | null) => T
): T {
	const directory = openTasksDirectory(paths, create);
	if (directory === null) {
		const result = operation(null);
		if (lstatPath(join(resolve(paths.stashDir), TASKS_DIRECTORY_NAME)) !== null) {
			throw new RuntimeFailure('conflict', 'Task directory changed during the operation');
		}
		return result;
	}
	try {
		const result = operation(directory);
		verifyCanonicalDirectory(directory);
		return result;
	} finally {
		closeDirectory(directory);
	}
}

function taskRevision(bytes: Buffer): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeUtf8(bytes: Buffer, message: string, code: AutomationRuntimeErrorCode): string {
	const text = bytes.toString('utf8');
	if (!Buffer.from(text, 'utf8').equals(bytes)) throw new RuntimeFailure(code, message);
	return text;
}

function encodeTaskContent(content: string): Buffer {
	const bytes = Buffer.from(content, 'utf8');
	if (bytes.toString('utf8') !== content) {
		throw new RuntimeFailure('invalid_request', 'Task content must be valid UTF-8 text');
	}
	if (bytes.byteLength > TASK_CONTENT_MAX_BYTES) {
		throw new RuntimeFailure('too_large', `Task content exceeds ${TASK_CONTENT_MAX_BYTES} bytes`);
	}
	return bytes;
}

function readTaskContentBytes(descriptor: number, fileName: string): Buffer {
	const buffer = Buffer.allocUnsafe(TASK_CONTENT_MAX_BYTES + 1);
	let offset = 0;
	while (offset < buffer.byteLength) {
		const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	if (offset > TASK_CONTENT_MAX_BYTES) {
		throw new RuntimeFailure(
			'too_large',
			`Task file exceeds ${TASK_CONTENT_MAX_BYTES} bytes: ${fileName}`
		);
	}
	return buffer.subarray(0, offset);
}

function readTaskSnapshot(directory: OpenDirectory, fileName: string): InternalTaskSnapshot | null {
	const before = lstatAt(directory, fileName);
	if (before === null) return null;
	if (!isSinglyLinkedRegularFile(before)) {
		throw new RuntimeFailure(
			'unsafe_file',
			`Task file is not a singly-linked regular file: ${fileName}`
		);
	}
	if (before.size > BigInt(TASK_CONTENT_MAX_BYTES)) {
		throw new RuntimeFailure(
			'too_large',
			`Task file exceeds ${TASK_CONTENT_MAX_BYTES} bytes: ${fileName}`
		);
	}

	let descriptor: number;
	try {
		descriptor = fs.openSync(
			join(directory.anchor, fileName),
			fs.constants.O_RDONLY | requiredFlag('O_NOFOLLOW') | requiredFlag('O_NONBLOCK')
		);
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return null;
		if (hasErrorCode(error, 'ELOOP', 'ENXIO')) {
			throw new RuntimeFailure('unsafe_file', `Unsafe task file: ${fileName}`);
		}
		throw error;
	}

	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (!isSinglyLinkedRegularFile(opened) || !sameSnapshot(before, opened)) {
			throw new RuntimeFailure('conflict', `Task file changed while opening: ${fileName}`);
		}
		const bytes = readTaskContentBytes(descriptor, fileName);
		const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
		const pathAfter = lstatAt(directory, fileName);
		if (
			pathAfter === null ||
			!isSinglyLinkedRegularFile(descriptorAfter) ||
			!isSinglyLinkedRegularFile(pathAfter) ||
			!sameSnapshot(opened, descriptorAfter) ||
			!sameSnapshot(descriptorAfter, pathAfter)
		) {
			throw new RuntimeFailure('conflict', `Task file changed while reading: ${fileName}`);
		}
		return {
			content: decodeUtf8(
				bytes,
				`Task file is not valid UTF-8 text: ${fileName}`,
				'unsafe_file'
			),
			revision: taskRevision(bytes),
			size: bytes.byteLength,
			stats: pathAfter
		};
	} finally {
		fs.closeSync(descriptor);
	}
}

type DirectoryScan = {
	candidateNames: string[];
	entryCount: number;
};

function scanTaskDirectory(directory: OpenDirectory): DirectoryScan {
	verifyCanonicalDirectory(directory);
	const handle = fs.opendirSync(directory.anchor);
	const candidateNames: string[] = [];
	let entryCount = 0;
	try {
		for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
			entryCount += 1;
			if (entryCount > AUTOMATION_RUNTIME_MAX_DIRECTORY_ENTRIES) {
				throw new RuntimeFailure(
					'too_large',
					`Task directory contains more than ${AUTOMATION_RUNTIME_MAX_DIRECTORY_ENTRIES} entries`
				);
			}
			if (!entry.name.endsWith('.yml')) continue;
			const nameError = portableTaskFilenameError(entry.name);
			if (nameError !== null) {
				throw new RuntimeFailure(
					'unsafe_file',
					`Task directory contains an unsafe .yml file name (${nameError})`
				);
			}
			if (candidateNames.length >= TASK_FILE_MAX_VISIBLE) {
				throw new RuntimeFailure(
					'too_large',
					`Task directory contains more than ${TASK_FILE_MAX_VISIBLE} task files`
				);
			}
			candidateNames.push(entry.name);
		}
	} finally {
		handle.closeSync();
	}
	return { candidateNames, entryCount };
}

function listTaskFiles(directory: OpenDirectory | null): AutomationTaskFileInfo[] {
	if (directory === null) return [];
	const files: AutomationTaskFileInfo[] = [];
	const names = scanTaskDirectory(directory).candidateNames.sort();
	const snapshots = new Map<string, BigIntStats>();
	for (const fileName of names) {
		const snapshot = readTaskSnapshot(directory, fileName);
		if (snapshot === null) {
			throw new RuntimeFailure('conflict', 'Task directory changed while being listed');
		}
		snapshots.set(fileName, snapshot.stats);
		files.push({
			fileName,
			taskId: taskIdFromTaskFilename(fileName),
			size: snapshot.size,
			revision: snapshot.revision,
			schedulable: isSchedulableTaskFilename(fileName)
		});
	}
	const namesAfter = scanTaskDirectory(directory).candidateNames.sort();
	if (
		namesAfter.length !== names.length ||
		namesAfter.some((fileName, index) => fileName !== names[index])
	) {
		throw new RuntimeFailure('conflict', 'Task directory changed while being listed');
	}
	for (const fileName of names) {
		const expected = snapshots.get(fileName);
		const current = lstatAt(directory, fileName);
		if (expected === undefined || current === null || !sameSnapshot(expected, current)) {
			throw new RuntimeFailure('conflict', 'Task directory changed while being listed');
		}
	}
	return files;
}

function descriptorMatchesBytes(descriptor: number, expected: Buffer): BigIntStats | null {
	const before = fs.fstatSync(descriptor, { bigint: true });
	if (!before.isFile() || before.size !== BigInt(expected.byteLength)) return null;
	const actual = Buffer.allocUnsafe(expected.byteLength + 1);
	let offset = 0;
	while (offset < actual.byteLength) {
		const bytesRead = fs.readSync(descriptor, actual, offset, actual.byteLength - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	const after = fs.fstatSync(descriptor, { bigint: true });
	if (
		offset !== expected.byteLength ||
		!actual.subarray(0, offset).equals(expected) ||
		!sameSnapshot(before, after)
	) {
		return null;
	}
	return after;
}

function writeStagedTaskFile(
	directory: OpenDirectory,
	fileName: string,
	bytes: Buffer,
	mode: number
): StagedTaskFile {
	const name = `.openpalm-task-${randomUUID()}.tmp`;
	const path = join(directory.anchor, name);
	let descriptor: number | null = null;
	try {
		descriptor = fs.openSync(
			path,
			fs.constants.O_RDWR |
				fs.constants.O_CREAT |
				fs.constants.O_EXCL |
				requiredFlag('O_NOFOLLOW') |
				requiredFlag('O_NONBLOCK'),
			mode
		);
		fs.fchmodSync(descriptor, mode);
		fs.writeFileSync(descriptor, bytes);
		fs.fsyncSync(descriptor);
		const stats = fs.fstatSync(descriptor, { bigint: true });
		const named = lstatAt(directory, name);
		if (
			named === null ||
			!isSinglyLinkedRegularFile(stats) ||
			!isSinglyLinkedRegularFile(named) ||
			!sameSnapshot(stats, named) ||
			descriptorMatchesBytes(descriptor, bytes) === null
		) {
			throw new RuntimeFailure('unsafe_file', `Staged task file changed while saving: ${fileName}`);
		}
		fs.fsyncSync(directory.descriptor);
		return { name, descriptor, stats };
	} catch (error) {
		if (descriptor !== null) {
			const descriptorStats = fs.fstatSync(descriptor, { bigint: true });
			const named = lstatAt(directory, name);
			if (named !== null && sameFile(descriptorStats, named)) {
				fs.unlinkSync(path);
				fs.fsyncSync(directory.descriptor);
			}
			fs.closeSync(descriptor);
		}
		throw error;
	}
}

function verifyStage(
	directory: OpenDirectory,
	stage: StagedTaskFile,
	bytes: Buffer
): BigIntStats {
	const descriptorStats = descriptorMatchesBytes(stage.descriptor, bytes);
	const named = lstatAt(directory, stage.name);
	if (
		descriptorStats === null ||
		named === null ||
		!isSinglyLinkedRegularFile(descriptorStats) ||
		!isSinglyLinkedRegularFile(named) ||
		!sameFile(stage.stats, descriptorStats) ||
		!sameSnapshot(descriptorStats, named)
	) {
		throw new RuntimeFailure('unsafe_file', 'Temporary task file changed before publication');
	}
	return descriptorStats;
}

function cleanupStage(directory: OpenDirectory, stage: StagedTaskFile): void {
	try {
		const named = lstatAt(directory, stage.name);
		if (named === null) return;
		const descriptorStats = fs.fstatSync(stage.descriptor, { bigint: true });
		if (!named.isFile() || !sameFile(descriptorStats, named)) {
			throw new RuntimeFailure('unsafe_file', 'A replaced temporary task file was preserved');
		}
		fs.unlinkSync(join(directory.anchor, stage.name));
		fs.fsyncSync(directory.descriptor);
	} finally {
		fs.closeSync(stage.descriptor);
	}
}

function verifyPublishedTask(
	directory: OpenDirectory,
	fileName: string,
	stage: StagedTaskFile,
	bytes: Buffer
): string {
	const published = readTaskSnapshot(directory, fileName);
	const descriptorStats = descriptorMatchesBytes(stage.descriptor, bytes);
	const revision = taskRevision(bytes);
	if (
		published === null ||
		descriptorStats === null ||
		!isSinglyLinkedRegularFile(descriptorStats) ||
		!sameFile(stage.stats, descriptorStats) ||
		!sameFile(descriptorStats, published.stats) ||
		published.revision !== revision
	) {
		throw new RuntimeFailure('conflict', `Task publication could not be verified: ${fileName}`);
	}
	return revision;
}

function createTaskFile(
	directory: OpenDirectory,
	fileName: string,
	bytes: Buffer,
	entryCount: number
): string {
	if (entryCount >= AUTOMATION_RUNTIME_MAX_DIRECTORY_ENTRIES) {
		throw new RuntimeFailure('too_large', 'Task directory has no bounded staging capacity');
	}
	const stage = writeStagedTaskFile(directory, fileName, bytes, 0o644);
	try {
		verifyStage(directory, stage, bytes);
		try {
			fs.linkSync(join(directory.anchor, stage.name), join(directory.anchor, fileName));
		} catch (error) {
			if (hasErrorCode(error, 'EEXIST')) {
				throw new RuntimeFailure('conflict', `Task file already exists: ${fileName}`);
			}
			throw error;
		}

		const staged = lstatAt(directory, stage.name);
		const target = lstatAt(directory, fileName);
		const descriptorStats = descriptorMatchesBytes(stage.descriptor, bytes);
		if (
			staged === null ||
			target === null ||
			descriptorStats === null ||
			!staged.isFile() ||
			!target.isFile() ||
			staged.nlink !== 2n ||
			target.nlink !== 2n ||
			descriptorStats.nlink !== 2n ||
			!sameFile(stage.stats, descriptorStats) ||
			!sameFile(descriptorStats, staged) ||
			!sameFile(descriptorStats, target)
		) {
			throw new RuntimeFailure('unsafe_file', `Task creation could not be verified: ${fileName}`);
		}

		fs.unlinkSync(join(directory.anchor, stage.name));
		fs.fsyncSync(directory.descriptor);
		return verifyPublishedTask(directory, fileName, stage, bytes);
	} finally {
		cleanupStage(directory, stage);
	}
}

function updateTaskFile(
	directory: OpenDirectory,
	fileName: string,
	bytes: Buffer,
	expectedRevision: string,
	original: InternalTaskSnapshot,
	entryCount: number
): string {
	if (entryCount >= AUTOMATION_RUNTIME_MAX_DIRECTORY_ENTRIES) {
		throw new RuntimeFailure('too_large', 'Task directory has no bounded staging capacity');
	}
	const stage = writeStagedTaskFile(
		directory,
		fileName,
		bytes,
		Number(original.stats.mode & 0o777n)
	);
	try {
		verifyStage(directory, stage, bytes);
		const current = readTaskSnapshot(directory, fileName);
		if (
			current === null ||
			current.revision !== expectedRevision ||
			!sameSnapshot(original.stats, current.stats)
		) {
			throw new RuntimeFailure('conflict', `Task file changed since it was loaded: ${fileName}`);
		}

		// Outer flock serializes OpenPalm; a same-user edit can race this recheck.
		// O_NOFOLLOW opens and rename never follow the target pathname's symlink.
		fs.renameSync(join(directory.anchor, stage.name), join(directory.anchor, fileName));
		fs.fsyncSync(directory.descriptor);
		return verifyPublishedTask(directory, fileName, stage, bytes);
	} finally {
		cleanupStage(directory, stage);
	}
}

function writeTaskFile(
	directory: OpenDirectory,
	fileName: string,
	bytes: Buffer,
	expectedRevision: string | null
): string {
	assertPortableTaskFilename(fileName);
	if (expectedRevision === null) assertSchedulableTaskFilename(fileName);
	else assertTaskRevision(expectedRevision);

	const scan = scanTaskDirectory(directory);
	const original = readTaskSnapshot(directory, fileName);
	if (expectedRevision === null) {
		if (original !== null) throw new RuntimeFailure('conflict', `Task file already exists: ${fileName}`);
		if (scan.candidateNames.length >= TASK_FILE_MAX_VISIBLE) {
			throw new RuntimeFailure(
				'too_large',
				`Task directory already contains ${TASK_FILE_MAX_VISIBLE} task files`
			);
		}
		return createTaskFile(directory, fileName, bytes, scan.entryCount);
	}
	if (original === null || original.revision !== expectedRevision) {
		throw new RuntimeFailure('conflict', `Task file changed since it was loaded: ${fileName}`);
	}
	return updateTaskFile(
		directory,
		fileName,
		bytes,
		expectedRevision,
		original,
		scan.entryCount
	);
}

function deleteTaskFile(
	directory: OpenDirectory,
	fileName: string,
	expectedRevision: string
): void {
	assertPortableTaskFilename(fileName);
	assertTaskRevision(expectedRevision);
	const original = readTaskSnapshot(directory, fileName);
	if (original === null || original.revision !== expectedRevision) {
		throw new RuntimeFailure('conflict', `Task file changed since it was loaded: ${fileName}`);
	}
	const current = readTaskSnapshot(directory, fileName);
	if (
		current === null ||
		current.revision !== expectedRevision ||
		!sameSnapshot(original.stats, current.stats)
	) {
		throw new RuntimeFailure('conflict', `Task file changed since it was loaded: ${fileName}`);
	}
	// The flock covers OpenPalm callers; a direct same-user pathname edit can
	// still race this final validation because unlink has no compare-and-swap form.
	fs.unlinkSync(join(directory.anchor, fileName));
	fs.fsyncSync(directory.descriptor);
	if (lstatAt(directory, fileName) !== null) {
		throw new RuntimeFailure('conflict', `Task file was recreated during deletion: ${fileName}`);
	}
}

function successEnvelope(result: AutomationRuntimeResult): AutomationRuntimeEnvelope {
	return {
		shape: AUTOMATION_RUNTIME_SHAPE,
		schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
		ok: true,
		result
	};
}

function boundedLogLines(fileName: string, lines: string[]): string[] {
	const emptyBytes = Buffer.byteLength(
		`${JSON.stringify(successEnvelope({ operation: 'logs', fileName, lines: [] }))}\n`
	);
	let remaining = AUTOMATION_LOG_MAX_RESPONSE_BYTES - emptyBytes;
	const selected: string[] = [];
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line === undefined) continue;
		const addition = Buffer.byteLength(JSON.stringify(line)) + (selected.length === 0 ? 0 : 1);
		if (addition > remaining) break;
		selected.push(line);
		remaining -= addition;
	}
	return selected.reverse();
}

function readAutomationLogs(
	paths: AutomationRuntimePaths,
	fileName: string,
	limit: number
): string[] {
	assertSchedulableTaskFilename(fileName);
	const taskId = taskIdFromTaskFilename(fileName);
	const databasePath = join(paths.dataDir, 'logs.db');
	const databaseStats = lstatPath(databasePath);
	if (databaseStats === null) return [];
	if (!isSinglyLinkedRegularFile(databaseStats)) {
		throw new RuntimeFailure('unsafe_file', 'AKM logs database is not a safe regular file');
	}

	const escapedTaskId = taskId.replaceAll("'", "''");
	const query =
		`SELECT line FROM (` +
		`SELECT id, line FROM task_logs WHERE task_id = '${escapedTaskId}' ` +
		`ORDER BY id DESC LIMIT ${limit}` +
		`) ORDER BY id ASC`;
	const databaseUri = `${pathToFileURL(databasePath).href}?mode=ro`;
	const result = childProcess.spawnSync(
		SQLITE_PATH,
		['-readonly', '-nofollow', '-batch', '-json', '-init', '/dev/null', databaseUri, query],
		{
			env: { LC_ALL: 'C.UTF-8' },
			maxBuffer: AUTOMATION_LOG_MAX_AGGREGATE_READ_BYTES,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 5_000
		}
	);
	if (result.error) {
		if (hasErrorCode(result.error, 'ENOBUFS')) {
			throw new RuntimeFailure('too_large', 'AKM log query output exceeds its byte limit');
		}
		throw new RuntimeFailure('io_error', 'Unable to query the AKM logs database');
	}
	if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
		throw new RuntimeFailure('io_error', 'Unable to query the AKM logs database');
	}
	if (result.stdout.byteLength > AUTOMATION_LOG_MAX_AGGREGATE_READ_BYTES) {
		throw new RuntimeFailure('too_large', 'AKM log query output exceeds its byte limit');
	}
	const output = decodeUtf8(
		result.stdout,
		'AKM log query output is not valid UTF-8',
		'unsafe_file'
	);
	if (output.trim().length === 0) return [];
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new RuntimeFailure('unsafe_file', 'AKM log query returned invalid JSON');
	}
	if (!Array.isArray(value) || value.length > limit) {
		throw new RuntimeFailure('unsafe_file', 'AKM log query returned an invalid row set');
	}
	const lines: string[] = [];
	for (const row of value) {
		if (!isRecord(row) || !hasExactKeys(row, ['line']) || typeof row.line !== 'string') {
			throw new RuntimeFailure('unsafe_file', 'AKM log query returned an invalid row');
		}
		lines.push(row.line);
	}
	return boundedLogLines(fileName, lines);
}

function parseRuntimeRequest(value: unknown): AutomationRuntimeRequest {
	if (!isRecord(value)) throw new RuntimeFailure('invalid_request', 'Request must be a JSON object');
	if (
		value.shape !== AUTOMATION_RUNTIME_SHAPE ||
		value.schemaVersion !== AUTOMATION_RUNTIME_SCHEMA_VERSION
	) {
		throw new RuntimeFailure('invalid_request', 'Unsupported automation runtime request envelope');
	}
	if (typeof value.operation !== 'string') {
		throw new RuntimeFailure('invalid_request', 'Request operation is required');
	}

	switch (value.operation) {
		case 'list':
			if (hasExactKeys(value, ['shape', 'schemaVersion', 'operation'])) {
				return value as AutomationRuntimeRequest;
			}
			break;
		case 'read':
			if (
				hasExactKeys(value, ['shape', 'schemaVersion', 'operation', 'fileName']) &&
				typeof value.fileName === 'string'
			) {
				return value as AutomationRuntimeRequest;
			}
			break;
		case 'write':
			if (
				hasExactKeys(value, [
					'shape',
					'schemaVersion',
					'operation',
					'fileName',
					'content',
					'expectedRevision'
				]) &&
				typeof value.fileName === 'string' &&
				typeof value.content === 'string' &&
				(value.expectedRevision === null || typeof value.expectedRevision === 'string')
			) {
				return value as AutomationRuntimeRequest;
			}
			break;
		case 'delete':
			if (
				hasExactKeys(value, [
					'shape',
					'schemaVersion',
					'operation',
					'fileName',
					'expectedRevision'
				]) &&
				typeof value.fileName === 'string' &&
				typeof value.expectedRevision === 'string'
			) {
				return value as AutomationRuntimeRequest;
			}
			break;
		case 'logs':
			if (
				hasExactKeys(value, ['shape', 'schemaVersion', 'operation', 'fileName', 'limit']) &&
				typeof value.fileName === 'string' &&
				typeof value.limit === 'number' &&
				Number.isInteger(value.limit) &&
				value.limit >= 1 &&
				value.limit <= 500
			) {
				return value as AutomationRuntimeRequest;
			}
	}
	throw new RuntimeFailure('invalid_request', 'Invalid automation runtime request fields');
}

function validateRuntimeRequest(request: AutomationRuntimeRequest): Buffer | null {
	switch (request.operation) {
		case 'list':
			return null;
		case 'read':
			assertPortableTaskFilename(request.fileName);
			return null;
		case 'write': {
			const portableError = portableTaskFilenameError(request.fileName);
			if (portableError !== null) throw new RuntimeFailure('invalid_name', portableError);
			if (request.expectedRevision === null) {
				const taskIdError = schedulableTaskFilenameError(request.fileName);
				if (taskIdError !== null) throw new RuntimeFailure('invalid_task_id', taskIdError);
			} else {
				try {
					assertTaskRevision(request.expectedRevision);
				} catch (error) {
					throw new RuntimeFailure('invalid_request', errorMessage(error));
				}
			}
			return encodeTaskContent(request.content);
		}
		case 'delete':
			assertPortableTaskFilename(request.fileName);
			try {
				assertTaskRevision(request.expectedRevision);
			} catch (error) {
				throw new RuntimeFailure('invalid_request', errorMessage(error));
			}
			return null;
		case 'logs': {
			const taskIdError = schedulableTaskFilenameError(request.fileName);
			if (taskIdError !== null) throw new RuntimeFailure('invalid_task_id', taskIdError);
			return null;
		}
	}
}

function normalizeFailure(error: unknown): RuntimeFailure {
	if (error instanceof RuntimeFailure) return error;
	if (error instanceof Error && /^Invalid task file name:/.test(error.message)) {
		return new RuntimeFailure('invalid_name', error.message);
	}
	if (error instanceof Error && /^Invalid schedulable task file name:/.test(error.message)) {
		return new RuntimeFailure('invalid_task_id', error.message);
	}
	return new RuntimeFailure('io_error', 'Automation runtime I/O operation failed');
}

export async function handleAutomationRuntimeRequest(
	value: unknown,
	paths: AutomationRuntimePaths = defaultPaths()
): Promise<AutomationRuntimeEnvelope> {
	try {
		if (process.platform !== 'linux') {
			throw new RuntimeFailure('unavailable', 'Automation runtime helper requires Linux');
		}
		const request = parseRuntimeRequest(value);
		const writeBytes = validateRuntimeRequest(request);
		switch (request.operation) {
			case 'list': {
				const files = withTasks(paths, false, listTaskFiles);
				return successEnvelope({ operation: 'list', files });
			}
			case 'read': {
				const snapshot = withTasks(paths, false, (directory) =>
					directory === null ? null : readTaskSnapshot(directory, request.fileName)
				);
				if (snapshot === null) {
					throw new RuntimeFailure('not_found', `Task file not found: ${request.fileName}`);
				}
				return successEnvelope({
					operation: 'read',
					fileName: request.fileName,
					content: snapshot.content,
					revision: snapshot.revision
				});
			}
			case 'write': {
				if (writeBytes === null) {
					throw new RuntimeFailure('invalid_request', 'Write request content was not validated');
				}
				const revision = withTasks(paths, true, (directory) => {
					if (directory === null) {
						throw new RuntimeFailure('io_error', 'Unable to create tasks directory');
					}
					return writeTaskFile(directory, request.fileName, writeBytes, request.expectedRevision);
				});
				return successEnvelope({ operation: 'write', fileName: request.fileName, revision });
			}
			case 'delete':
				withTasks(paths, false, (directory) => {
					if (directory === null) {
						throw new RuntimeFailure(
							'conflict',
							`Task file changed since it was loaded: ${request.fileName}`
						);
					}
					deleteTaskFile(directory, request.fileName, request.expectedRevision);
				});
				return successEnvelope({ operation: 'delete', fileName: request.fileName });
			case 'logs': {
				const lines = readAutomationLogs(paths, request.fileName, request.limit);
				return successEnvelope({ operation: 'logs', fileName: request.fileName, lines });
			}
		}
	} catch (error) {
		const failure = normalizeFailure(error);
		return {
			shape: AUTOMATION_RUNTIME_SHAPE,
			schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
			ok: false,
			error: { code: failure.code, message: failure.message }
		};
	}
}

async function readBoundedStdin(): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > AUTOMATION_RUNTIME_MAX_STDIN_BYTES) {
			throw new RuntimeFailure('too_large', 'Automation runtime request is too large');
		}
		chunks.push(bytes);
	}
	return Buffer.concat(chunks, size);
}

async function main(): Promise<void> {
	let envelope: AutomationRuntimeEnvelope;
	try {
		if (typeof process.getuid === 'function' && process.getuid() === 0) {
			throw new RuntimeFailure('unavailable', 'Automation runtime helper must not run as root');
		}
		const input = await readBoundedStdin();
		const inputText = decodeUtf8(input, 'Request body must be valid UTF-8', 'invalid_request');
		let value: unknown;
		try {
			value = JSON.parse(inputText);
		} catch {
			throw new RuntimeFailure('invalid_request', 'Request body must be valid JSON');
		}
		envelope = await handleAutomationRuntimeRequest(value);
	} catch (error) {
		const failure = normalizeFailure(error);
		envelope = {
			shape: AUTOMATION_RUNTIME_SHAPE,
			schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
			ok: false,
			error: { code: failure.code, message: failure.message }
		};
	}

	let output = `${JSON.stringify(envelope)}\n`;
	if (Buffer.byteLength(output) > AUTOMATION_RUNTIME_MAX_STDOUT_BYTES) {
		output = `${JSON.stringify({
			shape: AUTOMATION_RUNTIME_SHAPE,
			schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
			ok: false,
			error: { code: 'too_large', message: 'Automation runtime response is too large' }
		} satisfies AutomationRuntimeEnvelope)}\n`;
	}
	process.stdout.write(output);
}

const isMain =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
