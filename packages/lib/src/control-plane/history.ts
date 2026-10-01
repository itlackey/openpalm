import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { buildComposeOptions } from './compose.js';
import { composeConfigJson, composePs, parseComposePsRows, runDocker } from './docker.js';
import { createOpenPalmState, writeFileAtomic } from './foundation.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import { assertSafePortablePath } from './provider-files.js';

export type HistoryExportOptions = {
	sourceHome: string;
	image: string;
	destination: string;
	runtime?: string;
};
export type HistoryRestoreOptions = {
	homeDir: string;
	archive: string;
	directories: Record<string, string>;
	apply?: boolean;
	sameInstance?: boolean;
};
export type HistoryReceipt = {
	scope: 'native-history';
	sessions: number;
	messages: number;
	parts: number;
	applied: boolean;
	receipt: string;
};

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function directory(path: string): string {
	const resolved = resolve(path);
	if (!lstatSync(resolved).isDirectory() || lstatSync(resolved).isSymbolicLink())
		throw new Error(
			'History paths must be real directories; select the exact resolved source, not a symlink.'
		);
	return realpathSync(resolved);
}

function privateFolder(path: string, forbidden: string[]): string {
	const target = resolve(path);
	let parent = target;
	while (!existsSync(parent)) parent = resolve(parent, '..');
	const prospective = resolve(realpathSync(parent), relative(parent, target));
	if (forbidden.some((root) => inside(root, prospective) || inside(prospective, root)))
		throw new Error(
			'History recovery must use a private directory outside both instance homes and runtime sources.'
		);
	if (existsSync(target))
		throw new Error('Use a new history recovery directory; existing files are never overwritten.');
	mkdirSync(target, { recursive: true, mode: 0o700 });
	return directory(target);
}

export function validateHistoryDirectories(value: unknown): Record<string, string> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).length > 10_000
	)
		throw new Error('History directory map must be a bounded JSON object.');
	const result: Record<string, string> = {};
	for (const [source, target] of Object.entries(value)) {
		if (
			!source.startsWith('/') ||
			source.length > 4096 ||
			typeof target !== 'string' ||
			target.length > 4096 ||
			!(target === '/work' || target.startsWith('/work/')) ||
			target.includes('\\') ||
			[...source, ...target].some(
				(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
			) ||
			target
				.split('/')
				.some(
					(part) =>
						part === '.' ||
						part === '..' ||
						(part === '' && target !== '/work' && target.indexOf('//') >= 0)
				)
		) {
			throw new Error(
				'Map each old directory exactly to /work or a contained /work subdirectory; no traversal or automatic external mounts.'
			);
		}
		result[source] = target;
	}
	return result;
}

async function imageId(image: string): Promise<string> {
	if (!image || image.startsWith('-') || /\s/.test(image))
		throw new Error('Select the exact trusted Assistant image used by the source instance.');
	const result = await runDocker(['image', 'inspect', '--format', '{{.Id}}', image]);
	if (!result.ok || !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim()))
		throw new Error(
			'Assistant image is not installed. Pull the selected release image before recovery.'
		);
	return result.stdout.trim();
}

// This self-contained function is serialized into a one-off Bun process. It never
// starts an agent, loads original configuration, runs a prompt, or uses a network.
export async function historyWorker(): Promise<void> {
	const fs = await import('node:fs');
	const crypto = await import('node:crypto');
	const { execFileSync } = await import('node:child_process');
	const sqliteModule = 'bun:sqlite';
	const { Database } = (await import(sqliteModule)) as {
		Database: new (
			path: string,
			options: { readonly: boolean }
		) => {
			query(sql: string): { get(): unknown; all(): unknown[] };
			run(sql: string): void;
			close(): void;
		};
	};
	type Obj = Record<string, unknown>;
	const object = (value: unknown): Obj => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid native export.');
		return value as Obj;
	};
	const max = 256 * 1024 * 1024;
	const read = (file: string): unknown => {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
			throw new Error('History file must be a bounded regular private file.');
		return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
	};
	const canonical = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonical)
			: value && typeof value === 'object'
				? Object.fromEntries(
						Object.entries(value)
							.filter(([, entry]) => entry !== undefined)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, entry]) => [key, canonical(entry)])
					)
				: value;
	const hash = (value: unknown) =>
		crypto
			.createHash('sha256')
			.update(JSON.stringify(canonical(value)))
			.digest('hex');
	const write = (file: string, value: unknown) => {
		const temporary = `${file}.${crypto.randomUUID()}.tmp`;
		const descriptor = fs.openSync(temporary, 'wx', 0o600);
		try {
			fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		fs.renameSync(temporary, file);
	};
	const id = (value: unknown, prefix: string): string => {
		if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,128}$`).test(value))
			throw new Error('Invalid native history ID.');
		return value;
	};
	const sanitize = (
		value: unknown,
		rejectInterrupted = true
	): { info: Obj; messages: Array<{ info: Obj; parts: Obj[] }> } => {
		const data = object(value);
		const info = object(data.info);
		const session = id(info.id, 'ses');
		const clean: Obj = {};
		for (const key of ['id', 'slug', 'version', 'title', 'time', 'directory', 'projectID'])
			if (info[key] !== undefined) clean[key] = info[key];
		if (
			typeof info.directory !== 'string' ||
			!Array.isArray(data.messages) ||
			data.messages.length > 100_000
		)
			throw new Error('Invalid native history messages.');
		const seen = new Set<string>();
		const messages = data.messages.map((raw) => {
			const message = object(raw);
			const original = object(message.info);
			const messageID = id(original.id, 'msg');
			if (original.sessionID !== session || seen.has(messageID) || !Array.isArray(message.parts))
				throw new Error('History message ownership or ID is invalid.');
			seen.add(messageID);
			const messageInfo = { ...original };
			for (const key of ['tools', 'permission', 'permissions', 'metadata', 'system'])
				delete messageInfo[key];
			const parts = message.parts.map((rawPart) => {
				const part = { ...object(rawPart) };
				const partID = id(part.id, 'prt');
				if (part.sessionID !== session || part.messageID !== messageID || seen.has(partID))
					throw new Error('History part ownership or ID is invalid.');
				seen.add(partID);
				// An interrupted tool call must not become pending work in a new runtime.
				if (
					rejectInterrupted &&
					part.type === 'tool' &&
					['pending', 'running'].includes(String(object(part.state).status))
				)
					throw new Error(
						'Interrupted tool calls require manual review; private source snapshot retained.'
					);
				return part;
			});
			return { info: messageInfo, parts };
		});
		return { info: clean, messages };
	};
	const equalMessages = (
		expected: ReturnType<typeof sanitize>,
		actual: ReturnType<typeof sanitize>,
		partial = false
	): boolean => {
		for (const message of partial ? actual.messages : expected.messages) {
			const counterpart = (partial ? expected.messages : actual.messages).find(
				(item) => item.info.id === message.info.id
			);
			if (!counterpart || hash(message.info) !== hash(counterpart.info)) return false;
			for (const part of message.parts) {
				const other = counterpart.parts.find((item) => item.id === part.id);
				if (!other || hash(part) !== hash(other)) return false;
			}
		}
		return true;
	};
	fs.mkdirSync('/tmp/native/.local/share/opencode', { recursive: true, mode: 0o700 });
	fs.mkdirSync('/tmp/config', { recursive: true, mode: 0o700 });
	const env = {
		...process.env,
		HOME: '/tmp/native',
		XDG_DATA_HOME: '/tmp/native/.local/share',
		XDG_CONFIG_HOME: '/tmp/config',
		XDG_CACHE_HOME: '/tmp/cache',
		XDG_STATE_HOME: '/tmp/state',
		OPENCODE_CONFIG_DIR: '/tmp/config',
		OPENCODE_CONFIG_CONTENT: '{}',
		OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
		OPENCODE_DISABLE_CLAUDE_CODE: 'true',
		OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
		OPENCODE_DISABLE_AUTOUPDATE: 'true',
		GIT_CONFIG_SYSTEM: '/dev/null',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_COUNT: '2',
		GIT_CONFIG_KEY_0: 'core.fsmonitor',
		GIT_CONFIG_VALUE_0: 'false',
		GIT_CONFIG_KEY_1: 'core.hooksPath',
		GIT_CONFIG_VALUE_1: '/dev/null'
	};
	const native = (args: string[], cwd = '/tmp', output?: string): string => {
		const descriptor = output ? fs.openSync(output, 'w', 0o600) : undefined;
		try {
			return String(
				execFileSync('opencode', ['--pure', ...args], {
					cwd,
					env,
					timeout: 60_000,
					maxBuffer: max,
					stdio: ['ignore', descriptor ?? 'pipe', 'pipe']
				}) ?? ''
			);
		} catch {
			throw new Error(
				'Native history operation failed. Originals and private recovery files are retained; check engine compatibility.'
			);
		} finally {
			if (descriptor !== undefined) fs.closeSync(descriptor);
		}
	};
	const snapshot = (source: string, destination: string) => {
		const stat = fs.lstatSync(source);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 ** 3)
			throw new Error('History database must be a regular file at most 20 GiB.');
		let opened = source;
		if (!fs.existsSync(`${source}-wal`)) {
			// A cold WAL-mode database without sidecars can need temporary SHM creation
			// even on a read-only connection. Do that on a private copy, never the source.
			opened = `/tmp/cold-${crypto.randomUUID()}.sqlite`;
			fs.copyFileSync(source, opened);
			const after = fs.lstatSync(source);
			if (
				after.size !== stat.size ||
				after.mtimeMs !== stat.mtimeMs ||
				fs.existsSync(`${source}-wal`)
			)
				throw new Error('Source changed during cold snapshot; stop it and retry.');
		}
		const db = new Database(opened, { readonly: true });
		try {
			if (Object.values(object(db.query('PRAGMA integrity_check').get()))[0] !== 'ok')
				throw new Error('History database integrity check failed.');
			// VACUUM INTO produces a consistent standalone SQLite snapshot, including WAL.
			db.run(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
		} finally {
			db.close();
		}
		fs.chmodSync(destination, 0o600);
	};
	const dbPath = '/tmp/native/.local/share/opencode/opencode.db';
	const fileIntegrity = async (file: string) => {
		const digest = crypto.createHash('sha256');
		for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
		return { bytes: fs.statSync(file).size, sha256: digest.digest('hex') };
	};
	const mode = process.env.OP_HISTORY_MODE;
	if (mode === 'export') {
		snapshot('/source/opencode.db', '/recovery/source.sqlite');
		fs.copyFileSync('/recovery/source.sqlite', dbPath);
		const db = new Database(dbPath, { readonly: true });
		const sessions = db.query('SELECT id FROM session ORDER BY id').all() as Array<{ id: string }>;
		db.close();
		if (sessions.length > 10_000)
			throw new Error('History exceeds 10,000 sessions; split recovery with an operator.');
		const entries = [];
		let bytes = 0;
		for (const row of sessions) {
			const session = id(row.id, 'ses');
			const file = `/recovery/${session}.json`;
			native(['export', session], '/tmp', file);
			// Preservation must retain unfinished calls too; only activation is blocked.
			const data = sanitize(read(file), false);
			bytes += fs.statSync(file).size;
			if (bytes > 20 * 1024 ** 3) throw new Error('History exports exceed 20 GiB.');
			entries.push({
				id: session,
				directory: data.info.directory,
				sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
				messages: data.messages.length,
				parts: data.messages.reduce((sum, message) => sum + message.parts.length, 0)
			});
		}
		write('/recovery/history.json', {
			version: 1,
			scope: 'native-history',
			sourceSnapshot: await fileIntegrity('/recovery/source.sqlite'),
			engineVersion: native(['--version']).trim(),
			sessions: entries
		});
		return;
	}
	if (mode !== 'preview' && mode !== 'restore') throw new Error('Invalid history operation.');
	const manifest = object(read('/archive/history.json'));
	if (
		manifest.version !== 1 ||
		manifest.scope !== 'native-history' ||
		!Array.isArray(manifest.sessions) ||
		manifest.sessions.length > 10_000
	)
		throw new Error('Invalid history archive.');
	const directories = object(read('/recovery/directories.json'));
	const apply = mode === 'restore';
	// Preview uses only a snapshot. Apply uses the stopped target's native database.
	if (fs.existsSync('/target/opencode.db')) {
		snapshot('/target/opencode.db', '/recovery/target-before.sqlite');
		fs.copyFileSync('/recovery/target-before.sqlite', dbPath);
	}
	native(['db', 'SELECT id FROM session LIMIT 0']);
	const staged = new Database(dbPath, { readonly: true });
	const targetIDs = staged.query('SELECT id FROM session').all() as Array<{ id: string }>;
	if (targetIDs.length > 10_000)
		throw new Error('Target exceeds 10,000 sessions; split recovery with an operator.');
	const targetMessages = new Set(
		(staged.query('SELECT id FROM message').all() as Array<{ id: string }>).map((row) => row.id)
	);
	const targetParts = new Set(
		(staged.query('SELECT id FROM part').all() as Array<{ id: string }>).map((row) => row.id)
	);
	staged.close();
	const journalFile = '/target/openpalm-history-journal.json';
	const journal = fs.existsSync(journalFile) ? object(read(journalFile)) : {};
	const old = new Map<string, unknown>();
	for (const row of targetIDs) {
		const file = `/recovery/before-${id(row.id, 'ses')}.json`;
		native(['export', row.id], '/tmp', file);
		old.set(row.id, read(file));
	}
	const selected: Array<{
		data: ReturnType<typeof sanitize>;
		target: string;
		fingerprint: string;
		complete: boolean;
	}> = [];
	const sessionIDs = new Set<string>();
	const messageIDs = new Set<string>();
	const partIDs = new Set<string>();
	let totalBytes = 0;
	for (const raw of manifest.sessions) {
		const entry = object(raw);
		const session = id(entry.id, 'ses');
		if (sessionIDs.has(session)) throw new Error('Duplicate archive session ID.');
		sessionIDs.add(session);
		const file = `/archive/${session}.json`;
		const rawData = read(file);
		totalBytes += fs.statSync(file).size;
		if (
			totalBytes > 20 * 1024 ** 3 ||
			crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256
		)
			throw new Error('History archive checksum/size mismatch.');
		const data = sanitize(rawData);
		if (
			data.info.id !== session ||
			data.info.directory !== entry.directory ||
			data.messages.length !== entry.messages ||
			data.messages.reduce((sum, message) => sum + message.parts.length, 0) !== entry.parts
		)
			throw new Error('History inventory does not match its transcript.');
		const target = directories[String(data.info.directory)];
		if (
			typeof target !== 'string' ||
			!(target === '/work' || target.startsWith('/work/')) ||
			target.split('/').some((part) => part === '..' || part === '.')
		)
			throw new Error('Every old project directory needs an exact reviewed /work mapping.');
		if (!fs.lstatSync(target).isDirectory() || fs.realpathSync(target) !== target)
			throw new Error(
				'Mapped workspace directory must exist and contain no symlink. Restore its authored files first.'
			);
		data.info.directory = target;
		const fingerprint = hash(data);
		const previous =
			journal[session] && typeof journal[session] === 'object' ? object(journal[session]) : {};
		const resume = previous.fingerprint === fingerprint;
		const complete = resume && previous.complete === true;
		const existing = old.get(session);
		if (
			existing &&
			(!resume ||
				object(object(existing).info).directory !== target ||
				!equalMessages(data, sanitize(existing), !complete))
		)
			throw new Error('Destination session ID collision; nothing will be overwritten.');
		if (complete && !existing)
			throw new Error(
				'A previously recovered session is missing; review rather than resurrecting deleted history.'
			);
		for (const message of data.messages) {
			const mid = String(message.info.id);
			if (messageIDs.has(mid) || (!resume && targetMessages.has(mid)))
				throw new Error('Destination or archive message ID collision.');
			messageIDs.add(mid);
			for (const part of message.parts) {
				const pid = String(part.id);
				if (partIDs.has(pid) || (!resume && targetParts.has(pid)))
					throw new Error('Destination or archive part ID collision.');
				partIDs.add(pid);
			}
		}
		selected.push({ data, target, fingerprint, complete });
	}
	// Preflight the whole batch with the TARGET native engine before any target write.
	for (const item of selected) {
		if (item.complete) continue;
		const session = String(item.data.info.id);
		const file = `/recovery/import-${session}.json`;
		write(file, item.data);
		native(['import', file], item.target);
		const exported = `/recovery/check-${session}.json`;
		native(['export', session], item.target, exported);
		const actual = sanitize(read(exported));
		if (
			actual.info.directory !== item.target ||
			!equalMessages(item.data, actual) ||
			actual.messages.length !== item.data.messages.length ||
			actual.messages.reduce((sum, message) => sum + message.parts.length, 0) !==
				item.data.messages.reduce((sum, message) => sum + message.parts.length, 0)
		)
			throw new Error('Native round-trip content verification failed; target unchanged.');
	}
	for (const [session, data] of old) {
		if (selected.some((item) => item.data.info.id === session && !item.complete)) continue;
		const file = `/recovery/unchanged-${session}.json`;
		native(['export', session], '/tmp', file);
		if (hash(read(file)) !== hash(data))
			throw new Error('Existing target history changed during preflight; target unchanged.');
	}
	if (apply) {
		// Restartable per-session imports; journal intent is durable before native writes.
		env.XDG_DATA_HOME = '/native-data';
		for (const item of selected) {
			if (item.complete) continue;
			const session = String(item.data.info.id);
			journal[session] = { fingerprint: item.fingerprint, complete: false };
			write(journalFile, journal);
			native(['import', `/recovery/import-${session}.json`], item.target);
			const file = `/recovery/verified-${session}.json`;
			native(['export', session], item.target, file);
			const actual = sanitize(read(file));
			if (actual.info.directory !== item.target || !equalMessages(item.data, actual))
				throw new Error(
					'History verification failed; retain the recovery backup and rerun the same plan while stopped.'
				);
			journal[session] = { fingerprint: item.fingerprint, complete: true };
			write(journalFile, journal);
		}
		for (const [session, data] of old) {
			if (selected.some((item) => item.data.info.id === session && !item.complete)) continue;
			const file = `/recovery/retained-${session}.json`;
			native(['export', session], '/tmp', file);
			if (hash(read(file)) !== hash(data))
				throw new Error('Existing target session preservation check failed.');
		}
	}
	write('/recovery/receipt.json', {
		scope: 'native-history',
		sessions: selected.length,
		messages: messageIDs.size,
		parts: partIDs.size,
		applied: apply,
		existingSessionsPreserved: old.size,
		targetSnapshot: fs.existsSync('/recovery/target-before.sqlite')
			? await fileIntegrity('/recovery/target-before.sqlite')
			: null,
		directories,
		engineVersion: native(['--version']).trim(),
		limitations: [
			'Native history only, not portal handles or old access authority',
			'Referenced files, tools, snapshots, external roots and project dependencies require separate acceptance'
		]
	});
}

async function worker(image: string, mode: string, mounts: string[]): Promise<void> {
	const result = await runDocker(
		[
			'run',
			'--rm',
			'--pull',
			'never',
			'--network',
			'none',
			'--read-only',
			'--cap-drop',
			'ALL',
			'--security-opt',
			'no-new-privileges:true',
			'--user',
			`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
			'--tmpfs',
			'/tmp:rw,mode=1777',
			'--env',
			`OP_HISTORY_MODE=${mode}`,
			'--env',
			'HOME=/tmp/native',
			'--env',
			'OPENCODE_CONFIG_DIR=/tmp/config',
			...mounts,
			'--entrypoint',
			'bun',
			image,
			'-e',
			`(${historyWorker.toString()})().catch((error) => { console.error(error.message); process.exit(1); });`
		],
		{ timeoutMs: 30 * 60_000 }
	);
	if (!result.ok)
		throw new Error(
			`Native history recovery failed; originals and private recovery files retained. ${result.stderr.trim().slice(0, 1024)}`
		);
}

export async function exportHistory(
	options: HistoryExportOptions
): Promise<{ archive: string; sessions: number }> {
	const source = directory(options.sourceHome);
	const runtime = options.runtime
		? directory(options.runtime)
		: directory(join(source, 'data/assistant/.local/share/opencode'));
	if (!options.runtime)
		assertSafePortablePath(source, 'data/assistant/.local/share/opencode/opencode.db');
	assertSafePortablePath(runtime, 'opencode.db');
	for (const file of ['opencode.db-wal', 'opencode.db-shm', 'opencode.db-journal'])
		assertSafePortablePath(runtime, file, true);
	const image = await imageId(options.image);
	const archive = privateFolder(options.destination, [source, runtime]);
	writeFileAtomic(
		join(archive, 'source.json'),
		`${JSON.stringify({ sourceHome: source, runtime, image, createdAt: new Date().toISOString() }, null, 2)}\n`,
		0o600
	);
	await worker(image, 'export', [
		'--mount',
		`type=bind,src=${runtime},dst=/source,readonly`,
		'--mount',
		`type=bind,src=${archive},dst=/recovery`
	]);
	const manifest = JSON.parse(readFileSync(join(archive, 'history.json'), 'utf8')) as {
		sessions: unknown[];
	};
	return { archive, sessions: manifest.sessions.length };
}

export async function restoreHistory(options: HistoryRestoreOptions): Promise<HistoryReceipt> {
	const home = directory(options.homeDir);
	const archive = directory(options.archive);
	if (inside(home, archive) || inside(archive, home))
		throw new Error('History archive must remain outside the destination home.');
	assertSafePortablePath(archive, 'history.json');
	const map = validateHistoryDirectories(options.directories);
	for (const target of Object.values(map)) {
		const rel = target === '/work' ? 'workspace' : `workspace/${target.slice('/work/'.length)}`;
		assertSafePortablePath(home, rel);
	}
	if (options.apply && options.sameInstance !== true)
		throw new Error(
			'Confirm --same-instance only for a same-owner continuation of this instance; never mix unrelated histories.'
		);
	const state = createOpenPalmState(home);
	const compose = buildComposeOptions(state);
	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw new Error('Another OpenPalm lifecycle operation is in progress.');
	try {
		const status = await composePs(compose);
		if (
			!status.ok ||
			parseComposePsRows(status.stdout).some(
				(row) => row.state !== 'exited' && row.state !== 'created'
			)
		)
			throw new Error(
				'Stop the selected stack before native history preview or recovery. Do not stop unrelated instances.'
			);
		const configuration = await composeConfigJson(compose);
		const services = configuration.ok
			? (configuration.config as { services?: Record<string, { image?: string }> }).services
			: undefined;
		const image = await imageId(services?.assistant?.image ?? '');
		assertSafePortablePath(home, 'data/assistant', true);
		const runtime = join(home, 'data/assistant/.local/share/opencode');
		assertSafePortablePath(home, 'data/assistant/.local/share/opencode', true);
		mkdirSync(runtime, { recursive: true, mode: 0o700 });
		for (const file of [
			'opencode.db',
			'opencode.db-wal',
			'opencode.db-shm',
			'opencode.db-journal',
			'openpalm-history-journal.json'
		])
			assertSafePortablePath(runtime, file, true);
		const receipts = join(home, 'state/history-recovery');
		assertSafePortablePath(home, 'state/history-recovery', true);
		mkdirSync(receipts, { recursive: true, mode: 0o700 });
		const recovery = join(receipts, randomUUID());
		mkdirSync(recovery, { mode: 0o700 });
		writeFileAtomic(join(recovery, 'directories.json'), `${JSON.stringify(map)}\n`, 0o600);
		await worker(image, options.apply ? 'restore' : 'preview', [
			'--mount',
			`type=bind,src=${archive},dst=/archive,readonly`,
			'--mount',
			`type=bind,src=${recovery},dst=/recovery`,
			'--mount',
			`type=bind,src=${runtime},dst=/target${options.apply ? '' : ',readonly'}`,
			'--mount',
			`type=bind,src=${join(home, 'data/assistant/.local/share')},dst=/native-data${options.apply ? '' : ',readonly'}`,
			'--mount',
			`type=bind,src=${join(home, 'workspace')},dst=/work,readonly`
		]);
		const receipt = join(recovery, 'receipt.json');
		return {
			...(JSON.parse(readFileSync(receipt, 'utf8')) as Omit<HistoryReceipt, 'receipt'>),
			receipt
		};
	} finally {
		releaseStackLock(lock);
	}
}
