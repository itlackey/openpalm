import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleAutomationRuntimeRequest } from './automation-runtime-helper.js';
import type {
	AutomationRuntimeEnvelope,
	AutomationRuntimeRequest,
	AutomationRuntimeResult
} from './task-file-contract.js';
import {
	AUTOMATION_LOG_MAX_AGGREGATE_READ_BYTES,
	AUTOMATION_LOG_MAX_RESPONSE_BYTES,
	AUTOMATION_RUNTIME_MAX_DIRECTORY_ENTRIES,
	AUTOMATION_RUNTIME_SCHEMA_VERSION,
	AUTOMATION_RUNTIME_SHAPE,
	portableTaskFilenameError,
	schedulableTaskFilenameError,
	TASK_CONTENT_MAX_BYTES
} from './task-file-contract.js';

let root = '';
let stashDir = '';
let dataDir = '';

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'openpalm-automation-runtime-'));
	stashDir = join(root, 'stash');
	dataDir = join(root, 'data');
	mkdirSync(stashDir);
	mkdirSync(dataDir);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function request(
	value: Omit<AutomationRuntimeRequest, 'shape' | 'schemaVersion'>
): AutomationRuntimeRequest {
	return {
		shape: AUTOMATION_RUNTIME_SHAPE,
		schemaVersion: AUTOMATION_RUNTIME_SCHEMA_VERSION,
		...value
	} as AutomationRuntimeRequest;
}

async function invoke(value: unknown): Promise<AutomationRuntimeEnvelope> {
	return handleAutomationRuntimeRequest(value, { stashDir, dataDir });
}

async function result(value: AutomationRuntimeRequest): Promise<AutomationRuntimeResult> {
	const envelope = await invoke(value);
	expect(envelope.ok).toBe(true);
	if (!envelope.ok) throw new Error(envelope.error.message);
	return envelope.result;
}

function revision(content: string): string {
	return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function createLogsDatabase(
	rows: Array<{ taskId: string; line: string; ts?: string }>
): void {
	const database = new Database(join(dataDir, 'logs.db'), { create: true });
	try {
		database.exec(`
			CREATE TABLE task_logs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts TEXT NOT NULL,
				task_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				stream TEXT NOT NULL DEFAULT 'stdout',
				level TEXT NOT NULL DEFAULT 'info',
				line TEXT NOT NULL
			)
		`);
		const insert = database.query(
			'INSERT INTO task_logs (ts, task_id, run_id, line) VALUES (?1, ?2, ?3, ?4)'
		);
		for (const [index, row] of rows.entries()) {
			const ts = row.ts ?? `2026-08-02T00:00:0${index}.000Z`;
			insert.run(ts, row.taskId, `${row.taskId}@${ts}`, row.line);
		}
	} finally {
		database.close();
	}
}

describe('automation runtime helper task files', () => {
	it('creates, reads, updates, and deletes opaque UTF-8 with exact-content revisions', async () => {
		const original = 'not: [valid YAML\r\nprompt: café  \r\n';
		expect(
			await result(
				request({
					operation: 'write',
					fileName: 'daily.yml',
					content: original,
					expectedRevision: null
				})
			)
		).toEqual({ operation: 'write', fileName: 'daily.yml', revision: revision(original) });
		expect(await result(request({ operation: 'read', fileName: 'daily.yml' }))).toEqual({
			operation: 'read',
			fileName: 'daily.yml',
			content: original,
			revision: revision(original)
		});

		const replacement = 'replacement: opaque\n';
		expect(
			await result(
				request({
					operation: 'write',
					fileName: 'daily.yml',
					content: replacement,
					expectedRevision: revision(original)
				})
			)
		).toMatchObject({ revision: revision(replacement) });
		expect(
			await invoke(
				request({
					operation: 'write',
					fileName: 'daily.yml',
					content: 'stale',
					expectedRevision: revision(original)
				})
			)
		).toMatchObject({ ok: false, error: { code: 'conflict' } });

		await result(
			request({
				operation: 'delete',
				fileName: 'daily.yml',
				expectedRevision: revision(replacement)
			})
		);
		expect(readdirSync(join(stashDir, 'tasks'))).toEqual([]);
	});

	it('lists portable unschedulable files for repair', async () => {
		const tasksDir = join(stashDir, 'tasks');
		mkdirSync(tasksDir);
		for (const fileName of ['.yml', 'foo .yml', 'nested.yml.yml']) {
			writeFileSync(join(tasksDir, fileName), 'opaque');
		}
		const listed = await result(request({ operation: 'list' }));
		if (listed.operation !== 'list') throw new Error('expected list');
		expect(listed.files.map((file) => file.fileName)).toEqual([
			'.yml',
			'foo .yml',
			'nested.yml.yml'
		]);
		expect(listed.files.every((file) => !file.schedulable)).toBe(true);

		const target = listed.files.find((file) => file.fileName === 'foo .yml');
		if (!target) throw new Error('missing repair target');
		await result(
			request({
				operation: 'write',
				fileName: target.fileName,
				content: 'repaired',
				expectedRevision: target.revision
			})
		);
		await result(
			request({
				operation: 'delete',
				fileName: target.fileName,
				expectedRevision: revision('repaired')
			})
		);
	});

	it('fails listing instead of concealing unsafe or invalid .yml entries', async () => {
		const tasksDir = join(stashDir, 'tasks');
		const outside = join(root, 'outside.yml');
		writeFileSync(outside, 'outside');
		const cases: Array<() => void> = [
			() => symlinkSync(outside, join(tasksDir, 'symlink.yml')),
			() => linkSync(outside, join(tasksDir, 'hardlink.yml')),
			() => mkdirSync(join(tasksDir, 'directory.yml')),
			() => writeFileSync(join(tasksDir, 'malformed.yml'), Buffer.from([0xff])),
			() => writeFileSync(join(tasksDir, 'COM¹.yml'), 'reserved')
		];
		for (const setup of cases) {
			rmSync(tasksDir, { recursive: true, force: true });
			mkdirSync(tasksDir);
			setup();
			expect(await invoke(request({ operation: 'list' }))).toMatchObject({
				ok: false,
				error: { code: 'unsafe_file' }
			});
		}

		rmSync(tasksDir, { recursive: true, force: true });
		mkdirSync(tasksDir);
		writeFileSync(join(tasksDir, 'oversized.yml'), Buffer.alloc(TASK_CONTENT_MAX_BYTES + 1));
		expect(await invoke(request({ operation: 'list' }))).toMatchObject({
			ok: false,
			error: { code: 'too_large' }
		});
	});

	it('rejects Unicode format and bidi controls before access and safely diagnoses them on disk', async () => {
		for (const fileName of ['daily\u200byml.yml', 'invoice\u202ereversed.yml', 'task\u2066id.yml']) {
			expect(portableTaskFilenameError(fileName)).toContain('bidirectional control');
			expect(schedulableTaskFilenameError(fileName)).toContain('bidirectional control');
			const openSpy = spyOn(fs, 'openSync');
			try {
				expect(await invoke(request({ operation: 'read', fileName }))).toMatchObject({
					ok: false,
					error: { code: 'invalid_name' }
				});
				expect(openSpy).not.toHaveBeenCalled();
			} finally {
				openSpy.mockRestore();
			}
		}

		const spoofed = 'invoice\u202ereversed.yml';
		const tasksDir = join(stashDir, 'tasks');
		mkdirSync(tasksDir);
		writeFileSync(join(tasksDir, spoofed), 'opaque');
		const listed = await invoke(request({ operation: 'list' }));
		expect(listed).toMatchObject({ ok: false, error: { code: 'unsafe_file' } });
		if (listed.ok) throw new Error('expected unsafe list');
		expect(listed.error.message).not.toContain(spoofed);
	});

	it('never follows or mutates a task symlink or hard link', async () => {
		const tasksDir = join(stashDir, 'tasks');
		mkdirSync(tasksDir);
		const outside = join(root, 'outside.yml');
		writeFileSync(outside, 'outside');
		for (const [fileName, make] of [
			['symlink.yml', () => symlinkSync(outside, join(tasksDir, 'symlink.yml'))],
			['hardlink.yml', () => linkSync(outside, join(tasksDir, 'hardlink.yml'))]
		] as const) {
			make();
			for (const operation of [
				request({ operation: 'read', fileName }),
				request({
					operation: 'write',
					fileName,
					content: 'replacement',
					expectedRevision: revision('outside')
				}),
				request({ operation: 'delete', fileName, expectedRevision: revision('outside') })
			]) {
				expect(await invoke(operation)).toMatchObject({
					ok: false,
					error: { code: 'unsafe_file' }
				});
			}
			rmSync(join(tasksDir, fileName));
		}
		expect(readFileSync(outside, 'utf8')).toBe('outside');
	});

	it('uses link publication, rename replacement, and exact-path unlink without mv or journals', async () => {
		const originalLink = fs.linkSync;
		const originalRename = fs.renameSync;
		const originalUnlink = fs.unlinkSync;
		const links: string[][] = [];
		const renames: string[][] = [];
		const unlinks: string[] = [];
		const linkSpy = spyOn(fs, 'linkSync').mockImplementation(((source, target) => {
			links.push([String(source), String(target)]);
			return originalLink(source, target);
		}) as typeof fs.linkSync);
		const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((source, target) => {
			renames.push([String(source), String(target)]);
			return originalRename(source, target);
		}) as typeof fs.renameSync);
		const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(((path) => {
			unlinks.push(String(path));
			return originalUnlink(path);
		}) as typeof fs.unlinkSync);
		const spawnSpy = spyOn(childProcess, 'spawnSync');
		try {
			await result(
				request({
					operation: 'write',
					fileName: 'daily.yml',
					content: 'one',
					expectedRevision: null
				})
			);
			await result(
				request({
					operation: 'write',
					fileName: 'daily.yml',
					content: 'two',
					expectedRevision: revision('one')
				})
			);
			await result(
				request({ operation: 'delete', fileName: 'daily.yml', expectedRevision: revision('two') })
			);
		} finally {
			linkSpy.mockRestore();
			renameSpy.mockRestore();
			unlinkSpy.mockRestore();
			spawnSpy.mockRestore();
		}

		expect(links).toHaveLength(1);
		expect(dirname(links[0]?.[0] ?? '')).toBe(dirname(links[0]?.[1] ?? ''));
		expect(links[0]?.[1]).toEndWith('/daily.yml');
		expect(renames).toHaveLength(1);
		expect(dirname(renames[0]?.[0] ?? '')).toBe(dirname(renames[0]?.[1] ?? ''));
		expect(renames[0]?.[1]).toEndWith('/daily.yml');
		expect(unlinks.some((path) => path.endsWith('/daily.yml'))).toBe(true);
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(readdirSync(join(stashDir, 'tasks'))).toEqual([]);
	});

	it('does not report success when a create stage is swapped before publication', async () => {
		const originalLink = fs.linkSync;
		let swapped = false;
		const linkSpy = spyOn(fs, 'linkSync').mockImplementation(((source, target) => {
			fs.unlinkSync(source);
			fs.writeFileSync(source, 'swapped stage');
			swapped = true;
			return originalLink(source, target);
		}) as typeof fs.linkSync);
		try {
			expect(
				await invoke(
					request({
						operation: 'write',
						fileName: 'daily.yml',
						content: 'requested content',
						expectedRevision: null
					})
				)
			).toMatchObject({ ok: false, error: { code: 'unsafe_file' } });
		} finally {
			linkSpy.mockRestore();
		}
		expect(swapped).toBe(true);
		expect(readFileSync(join(stashDir, 'tasks', 'daily.yml'), 'utf8')).toBe('swapped stage');
	});

	it('does not report success when an update stage is swapped before rename', async () => {
		const tasksDir = join(stashDir, 'tasks');
		mkdirSync(tasksDir);
		writeFileSync(join(tasksDir, 'daily.yml'), 'original');
		const originalRename = fs.renameSync;
		let swapped = false;
		const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((source, target) => {
			fs.unlinkSync(source);
			fs.writeFileSync(source, 'swapped stage');
			swapped = true;
			return originalRename(source, target);
		}) as typeof fs.renameSync);
		try {
			expect(
				await invoke(
					request({
						operation: 'write',
						fileName: 'daily.yml',
						content: 'requested content',
						expectedRevision: revision('original')
					})
				)
			).toMatchObject({ ok: false, error: { code: 'conflict' } });
		} finally {
			renameSpy.mockRestore();
		}
		expect(swapped).toBe(true);
		expect(readFileSync(join(tasksDir, 'daily.yml'), 'utf8')).toBe('swapped stage');
	});

	it('fails completion when the canonical tasks pathname is replaced', async () => {
		const tasksDir = join(stashDir, 'tasks');
		const detachedDir = join(stashDir, 'detached-tasks');
		mkdirSync(tasksDir);
		writeFileSync(join(tasksDir, 'daily.yml'), 'original');
		const originalRename = fs.renameSync;
		let replaced = false;
		const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((source, target) => {
			const renamed = originalRename(source, target);
			if (!replaced && String(target).endsWith('/daily.yml')) {
				originalRename(tasksDir, detachedDir);
				mkdirSync(tasksDir);
				replaced = true;
			}
			return renamed;
		}) as typeof fs.renameSync);
		try {
			expect(
				await invoke(
					request({
						operation: 'write',
						fileName: 'daily.yml',
						content: 'replacement',
						expectedRevision: revision('original')
					})
				)
			).toMatchObject({ ok: false, error: { code: 'unsafe_file' } });
		} finally {
			renameSpy.mockRestore();
		}
		expect(replaced).toBe(true);
		expect(readdirSync(tasksDir)).toEqual([]);
		expect(readFileSync(join(detachedDir, 'daily.yml'), 'utf8')).toBe('replacement');
	});

	it('fails listing when a task changes after its content was read', async () => {
		const tasksDir = join(stashDir, 'tasks');
		const target = join(tasksDir, 'daily.yml');
		mkdirSync(tasksDir);
		writeFileSync(target, 'original');
		const originalOpendir = fs.opendirSync;
		let scans = 0;
		const opendirSpy = spyOn(fs, 'opendirSync').mockImplementation(((path, options) => {
			scans += 1;
			if (scans === 2) writeFileSync(target, 'changed after read');
			return originalOpendir(path, options);
		}) as typeof fs.opendirSync);
		try {
			expect(await invoke(request({ operation: 'list' }))).toMatchObject({
				ok: false,
				error: { code: 'conflict' }
			});
		} finally {
			opendirSpy.mockRestore();
		}
		expect(scans).toBe(2);
	});

	it('enforces task content, visible file, and total directory entry limits', async () => {
		expect(
			await invoke(
				request({
					operation: 'write',
					fileName: 'large.yml',
					content: 'x'.repeat(TASK_CONTENT_MAX_BYTES + 1),
					expectedRevision: null
				})
			)
		).toMatchObject({ ok: false, error: { code: 'too_large' } });
		expect(fs.existsSync(join(stashDir, 'tasks'))).toBe(false);

		const tasksDir = join(stashDir, 'tasks');
		mkdirSync(tasksDir);
		for (let index = 0; index < 1_001; index += 1) {
			writeFileSync(join(tasksDir, `task-${String(index).padStart(4, '0')}.yml`), 'x');
		}
		expect(await invoke(request({ operation: 'list' }))).toMatchObject({
			ok: false,
			error: { code: 'too_large' }
		});

		rmSync(tasksDir, { recursive: true, force: true });
		mkdirSync(tasksDir);
		for (let index = 0; index <= AUTOMATION_RUNTIME_MAX_DIRECTORY_ENTRIES; index += 1) {
			writeFileSync(join(tasksDir, `ignored-${index}.txt`), '');
		}
		expect(await invoke(request({ operation: 'list' }))).toMatchObject({
			ok: false,
			error: { code: 'too_large' }
		});
	});
});

describe('automation runtime helper logs and protocol', () => {
	it('queries authoritative logs.db read-only and returns recent lines chronologically', async () => {
		createLogsDatabase([
			{ taskId: 'daily', line: 'oldest' },
			{ taskId: 'other', line: 'other task' },
			{ taskId: 'daily', line: 'middle' },
			{ taskId: 'daily', line: 'newest' }
		]);
		const originalSpawn = childProcess.spawnSync;
		let invocation: { command: string; args: string[]; options: unknown } | null = null;
		const spawnSpy = spyOn(childProcess, 'spawnSync').mockImplementation(((command, args, options) => {
			invocation = {
				command: String(command),
				args: Array.isArray(args) ? args.map(String) : [],
				options
			};
			return Reflect.apply(originalSpawn, childProcess, [command, args, options]);
		}) as typeof childProcess.spawnSync);
		try {
			expect(await result(request({ operation: 'logs', fileName: 'daily.yml', limit: 2 }))).toEqual({
				operation: 'logs',
				fileName: 'daily.yml',
				lines: ['middle', 'newest']
			});
		} finally {
			spawnSpy.mockRestore();
		}
		expect(invocation).not.toBeNull();
		if (invocation === null) throw new Error('sqlite3 was not invoked');
		expect(invocation.command).toBe('/usr/bin/sqlite3');
		expect(invocation.args).toContain('-readonly');
		expect(invocation.args).toContain('-nofollow');
		expect(invocation.args).toContain('-json');
		expect(invocation.args).toContain(`${pathToFileURL(join(dataDir, 'logs.db')).href}?mode=ro`);
		expect(invocation.args.at(-1)).toContain("task_id = 'daily'");
		expect(invocation.options).toMatchObject({
			maxBuffer: AUTOMATION_LOG_MAX_AGGREGATE_READ_BYTES,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		expect(invocation.options).not.toHaveProperty('shell');
	});

	it('keeps the newest complete rows within the response byte limit', async () => {
		const old = `old-${'a'.repeat(700_000)}`;
		const middle = `middle-${'b'.repeat(700_000)}`;
		const newest = `newest-${'c'.repeat(700_000)}`;
		createLogsDatabase([
			{ taskId: 'daily', line: old },
			{ taskId: 'daily', line: middle },
			{ taskId: 'daily', line: newest }
		]);
		const envelope = await invoke(request({ operation: 'logs', fileName: 'daily.yml', limit: 3 }));
		expect(envelope).toMatchObject({ ok: true, result: { lines: [newest] } });
		expect(Buffer.byteLength(`${JSON.stringify(envelope)}\n`)).toBeLessThanOrEqual(
			AUTOMATION_LOG_MAX_RESPONSE_BYTES
		);
	});

	it('returns no lines for a missing database or empty query and rejects an unsafe database path', async () => {
		expect(await result(request({ operation: 'logs', fileName: 'daily.yml', limit: 10 }))).toEqual({
			operation: 'logs',
			fileName: 'daily.yml',
			lines: []
		});
		createLogsDatabase([{ taskId: 'other', line: 'not selected' }]);
		expect(await result(request({ operation: 'logs', fileName: 'daily.yml', limit: 10 }))).toEqual({
			operation: 'logs',
			fileName: 'daily.yml',
			lines: []
		});
		rmSync(join(dataDir, 'logs.db'));
		const outside = join(root, 'outside.db');
		writeFileSync(outside, 'not sqlite');
		symlinkSync(outside, join(dataDir, 'logs.db'));
		expect(
			await invoke(request({ operation: 'logs', fileName: 'daily.yml', limit: 10 }))
		).toMatchObject({ ok: false, error: { code: 'unsafe_file' } });
	});

	it('rejects unschedulable log IDs and strict protocol violations', async () => {
		for (const fileName of ['.yml', 'foo .yml', 'nested.yml.yml']) {
			expect(await invoke(request({ operation: 'logs', fileName, limit: 10 }))).toMatchObject({
				ok: false,
				error: { code: 'invalid_task_id' }
			});
		}
		expect(await invoke({ operation: 'list' })).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' }
		});
		expect(await invoke({ ...request({ operation: 'list' }), extra: true })).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' }
		});
	});
});
