import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
	symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { exportHistory, restoreHistory, validateHistoryDirectories } from './history.js';
import { runDocker } from './docker.js';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';

describe('native history directory boundaries', () => {
	it('accepts exact reviewed workspace contexts only', () => {
		expect(
			validateHistoryDirectories({ '/old/home': '/work', '/old/project': '/work/project' })
		).toEqual({ '/old/home': '/work', '/old/project': '/work/project' });
		for (const target of [
			'/host-stash',
			'/work/../private',
			'/work/./project',
			'/work//project',
			'/work\\escape',
			'/work/project\n'
		])
			expect(() => validateHistoryDirectories({ '/old': target })).toThrow();
		expect(() => validateHistoryDirectories([])).toThrow();
		expect(() => validateHistoryDirectories({ relative: '/work' })).toThrow();
	});

	it('rejects linked SQLite rollback journals before invoking Docker', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-history-journal-test-'));
		const source = join(root, 'old');
		const runtime = join(source, 'data/assistant/.local/share/opencode');
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, 'opencode.db'), 'fixture');
		writeFileSync(join(root, 'external'), 'must remain untouched');
		symlinkSync(join(root, 'external'), join(runtime, 'opencode.db-journal'));
		await expect(
			exportHistory({
				sourceHome: source,
				image: 'not-installed',
				destination: join(root, 'archive')
			})
		).rejects.toThrow('unsafe component: opencode.db-journal');
		expect(readFileSync(join(root, 'external'), 'utf8')).toBe('must remain untouched');
	});
});

const image = process.env.OPENPALM_HISTORY_TEST_IMAGE;
const oldImage = process.env.OPENPALM_HISTORY_SOURCE_IMAGE ?? image;

describe.skipIf(!image)('offline native history recovery (real Assistant engines)', () => {
	it('exports WAL data, strips authority, preserves target work, verifies content and safely resumes', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-history-e2e-'));
		const source = join(root, 'old');
		const target = join(root, 'new');
		const archive = join(root, 'private-history');
		const runtime = (home: string) => join(home, 'data/assistant/.local/share/opencode');
		for (const home of [source, target]) {
			mkdirSync(runtime(home), { recursive: true });
			mkdirSync(join(home, 'workspace/project'), { recursive: true });
			writeStackConfig(home, defaultStackConfig());
		}
		mkdirSync(join(target, 'system/stack'), { recursive: true });
		writeFileSync(
			join(target, 'system/stack/stack.compose.yml'),
			`services:\n  assistant:\n    image: ${image}\n`
		);
		mkdirSync(join(target, 'state'), { recursive: true });
		writeFileSync(
			join(target, 'state/stack.env'),
			`OP_PROJECT_NAME=openpalm-history-test-${process.pid}\n`
		);
		const transcript = (session: string, message: string, part: string, title: string) => ({
			info: {
				id: session,
				slug: 'history-test',
				projectID: 'global',
				directory: '/work',
				title,
				version: '1.18.21',
				time: { created: 1780000000000, updated: 1780000000000 }
			},
			messages: [
				{
					info: {
						id: message,
						sessionID: session,
						role: 'user',
						time: { created: 1780000000000 },
						agent: 'build',
						model: { providerID: 'test', modelID: 'test' }
					},
					parts: [{ id: part, sessionID: session, messageID: message, type: 'text', text: title }]
				}
			]
		});
		const seed = async (home: string, engine: string, data: unknown) => {
			const file = join(home, 'seed.json');
			writeFileSync(file, JSON.stringify(data));
			const result = await runDocker([
				'run',
				'--rm',
				'--network',
				'none',
				'--read-only',
				'--cap-drop',
				'ALL',
				'--security-opt',
				'no-new-privileges:true',
				'--user',
				`${process.getuid?.()}:${process.getgid?.()}`,
				'--tmpfs',
				'/tmp:rw,mode=1777',
				'--env',
				'HOME=/tmp/native',
				'--env',
				'XDG_DATA_HOME=/native-data',
				'--env',
				'XDG_CONFIG_HOME=/tmp/config',
				'--env',
				'OPENCODE_CONFIG_DIR=/tmp/config',
				'--env',
				'OPENCODE_CONFIG_CONTENT={}',
				'--env',
				'OPENCODE_DISABLE_PROJECT_CONFIG=true',
				'--mount',
				`type=bind,src=${join(home, 'data/assistant/.local/share')},dst=/native-data`,
				'--mount',
				`type=bind,src=${file},dst=/seed.json,readonly`,
				'--entrypoint',
				'opencode',
				engine,
				'--pure',
				'import',
				'/seed.json'
			]);
			if (!result.ok) throw new Error(result.stderr);
		};
		await seed(
			source,
			String(oldImage),
			transcript('ses_source1', 'msg_source1', 'prt_source1', 'authored old conversation')
		);
		await seed(
			target,
			String(image),
			transcript(
				'ses_existing1',
				'msg_existing1',
				'prt_existing1',
				'existing destination conversation'
			)
		);
		const db = new Database(join(runtime(source), 'opencode.db'));
		db.run('PRAGMA journal_mode=WAL');
		db.run('PRAGMA wal_autocheckpoint=0');
		db.run(
			'UPDATE session SET directory=\'/old/home\', permission=\'[{"permission":"*","action":"allow","pattern":"*"}]\' WHERE id=\'ses_source1\''
		);
		expect(statSync(join(runtime(source), 'opencode.db-wal')).size).toBeGreaterThan(0);
		const beforeSource = createHash('sha256')
			.update(readFileSync(join(runtime(source), 'opencode.db')))
			.digest('hex');
		const beforeTarget = createHash('sha256')
			.update(readFileSync(join(runtime(target), 'opencode.db')))
			.digest('hex');
		try {
			const exported = await exportHistory({
				sourceHome: source,
				image: String(oldImage),
				destination: archive
			});
			expect(exported.sessions).toBe(1);
			expect(statSync(archive).mode & 0o777).toBe(0o700);
			expect(
				createHash('sha256')
					.update(readFileSync(join(runtime(source), 'opencode.db')))
					.digest('hex')
			).toBe(beforeSource);
			const manifest = JSON.parse(readFileSync(join(archive, 'history.json'), 'utf8'));
			expect(manifest.sessions[0].directory).toBe('/old/home');
			const options = { homeDir: target, archive, directories: { '/old/home': '/work/project' } };
			const collisionArchive = join(root, 'collision-history');
			mkdirSync(collisionArchive);
			const originalExport = JSON.parse(readFileSync(join(archive, 'ses_source1.json'), 'utf8'));
			const collisionExport = structuredClone(originalExport);
			collisionExport.messages[0].info.id = 'msg_existing1';
			collisionExport.messages[0].parts[0].messageID = 'msg_existing1';
			const collisionBytes = JSON.stringify(collisionExport);
			writeFileSync(join(collisionArchive, 'ses_source1.json'), collisionBytes);
			writeFileSync(
				join(collisionArchive, 'history.json'),
				JSON.stringify({
					...manifest,
					sessions: [
						{
							...manifest.sessions[0],
							sha256: createHash('sha256').update(collisionBytes).digest('hex')
						}
					]
				})
			);
			await expect(
				restoreHistory({ ...options, archive: collisionArchive, apply: true, sameInstance: true })
			).rejects.toThrow('message ID collision');
			expect(
				createHash('sha256')
					.update(readFileSync(join(runtime(target), 'opencode.db')))
					.digest('hex')
			).toBe(beforeTarget);
			await expect(restoreHistory({ ...options, directories: {} })).rejects.toThrow('mapping');
			const preview = await restoreHistory(options);
			expect(preview.applied).toBe(false);
			expect(
				createHash('sha256')
					.update(readFileSync(join(runtime(target), 'opencode.db')))
					.digest('hex')
			).toBe(beforeTarget);
			await expect(restoreHistory({ ...options, apply: true })).rejects.toThrow('same-instance');
			const restored = await restoreHistory({ ...options, apply: true, sameInstance: true });
			expect(restored).toMatchObject({ sessions: 1, messages: 1, parts: 1, applied: true });
			const targetDB = new Database(join(runtime(target), 'opencode.db'));
			try {
				expect(
					targetDB.query('SELECT id, directory, permission FROM session ORDER BY id').all()
				).toEqual([
					{ id: 'ses_existing1', directory: '/work', permission: null },
					{ id: 'ses_source1', directory: '/work/project', permission: null }
				]);
				expect(targetDB.query('SELECT count(*) AS total FROM message').get()).toEqual({ total: 2 });
			} finally {
				targetDB.close();
			}
			const repeated = await restoreHistory({ ...options, apply: true, sameInstance: true });
			expect(repeated.sessions).toBe(1);
			// Simulate a crash between native message/part writes and final journal verification.
			const journalPath = join(runtime(target), 'openpalm-history-journal.json');
			const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
			journal.ses_source1.complete = false;
			writeFileSync(journalPath, JSON.stringify(journal));
			const interrupted = new Database(join(runtime(target), 'opencode.db'));
			interrupted.run("DELETE FROM part WHERE id='prt_source1'");
			interrupted.close();
			await restoreHistory({ ...options, apply: true, sameInstance: true });
			const resumed = new Database(join(runtime(target), 'opencode.db'));
			expect(resumed.query('SELECT count(*) AS total FROM part').get()).toEqual({ total: 2 });
			// New work in a recovered conversation must survive subsequent reruns.
			resumed.run(
				"INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('msg_later1','ses_source1',1780000000010,1780000000010,?)",
				[
					JSON.stringify({
						role: 'user',
						time: { created: 1780000000010 },
						agent: 'build',
						model: { providerID: 'test', modelID: 'test' }
					})
				]
			);
			resumed.run(
				"INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('prt_later1','msg_later1','ses_source1',1780000000010,1780000000010,?)",
				[JSON.stringify({ type: 'text', text: 'new work after recovery' })]
			);
			resumed.close();
			await restoreHistory({ ...options, apply: true, sameInstance: true });
			const retained = new Database(join(runtime(target), 'opencode.db'));
			expect(retained.query('SELECT count(*) AS total FROM message').get()).toEqual({ total: 3 });
			retained.close();
			// Verify discovery and content through a real authenticated native API.
			const serverName = `openpalm-history-api-${process.pid}`;
			const started = await runDocker([
				'run',
				'-d',
				'--rm',
				'--name',
				serverName,
				'--cap-drop',
				'ALL',
				'--security-opt',
				'no-new-privileges:true',
				'--user',
				`${process.getuid?.()}:${process.getgid?.()}`,
				'--tmpfs',
				'/tmp:rw,mode=1777',
				'--network',
				'none',
				'--env',
				'HOME=/tmp/native',
				'--env',
				'XDG_DATA_HOME=/native-data',
				'--env',
				'XDG_CONFIG_HOME=/tmp/config',
				'--env',
				'OPENCODE_CONFIG_DIR=/tmp/config',
				'--env',
				'OPENCODE_CONFIG_CONTENT={}',
				'--env',
				'OPENCODE_DISABLE_PROJECT_CONFIG=true',
				'--env',
				'OPENCODE_SERVER_PASSWORD=synthetic-history-test-only',
				'--mount',
				`type=bind,src=${join(target, 'data/assistant/.local/share')},dst=/native-data`,
				'--mount',
				`type=bind,src=${join(target, 'workspace')},dst=/work,readonly`,
				'--entrypoint',
				'opencode',
				String(image),
				'--pure',
				'serve',
				'--hostname',
				'0.0.0.0',
				'--port',
				'4096'
			]);
			if (!started.ok) throw new Error(started.stderr);
			try {
				const verified = await runDocker(
					[
						'exec',
						serverName,
						'bun',
						'-e',
						`
				const endpoint='http://127.0.0.1:4096';
				const headers={authorization:'Basic '+Buffer.from('opencode:synthetic-history-test-only').toString('base64')};
				for(let attempt=0;attempt<50;attempt++){try{if((await fetch(endpoint+'/global/health',{headers,signal:AbortSignal.timeout(1000)})).ok)break;}catch{}await Bun.sleep(100);}
				const unauthorized=(await fetch(endpoint+'/session',{signal:AbortSignal.timeout(5000)})).status;
				const sessions=await fetch(endpoint+'/session?directory=/work/project',{headers,signal:AbortSignal.timeout(5000)}).then(r=>r.json());
				const messages=await fetch(endpoint+'/session/ses_source1/message?directory=/work/project',{headers,signal:AbortSignal.timeout(5000)}).then(r=>r.json());
				console.log(JSON.stringify({unauthorized,sessions:sessions.map(s=>s.id),messages:messages.map(m=>m.info.id),text:messages[0].parts[0].text}));
				`
					],
					{ timeoutMs: 30_000 }
				);
				if (!verified.ok) throw new Error(verified.stderr);
				expect(JSON.parse(verified.stdout)).toEqual({
					unauthorized: 401,
					sessions: ['ses_source1'],
					messages: ['msg_source1', 'msg_later1'],
					text: 'authored old conversation'
				});
			} finally {
				await runDocker(['stop', serverName]);
			}
			// A tampered archive cannot overwrite an existing target session.
			writeFileSync(join(archive, 'ses_source1.json'), '{}');
			await expect(
				restoreHistory({ ...options, apply: true, sameInstance: true })
			).rejects.toThrow();
			// Unfinished work still gets a private export, but cannot become pending work.
			db.run(
				"INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('prt_pending1','msg_source1','ses_source1',1780000000020,1780000000020,?)",
				[
					JSON.stringify({
						type: 'tool',
						tool: 'bash',
						callID: 'pending-test',
						state: { status: 'pending', input: {}, raw: '' }
					})
				]
			);
			const pendingArchive = join(root, 'pending-history');
			const pendingExport = await exportHistory({
				sourceHome: source,
				image: String(oldImage),
				destination: pendingArchive
			});
			expect(pendingExport.sessions).toBe(1);
			expect(
				JSON.parse(readFileSync(join(pendingArchive, 'history.json'), 'utf8')).sessions[0].parts
			).toBe(2);
			await expect(restoreHistory({ ...options, archive: pendingArchive })).rejects.toThrow(
				'Interrupted tool calls'
			);
		} finally {
			db.close();
		}
		// Preserve evidence; never delete user-style recovery homes as test cleanup.
		console.log(`Native migration evidence: ${root}`);
	}, 240_000);

	it('requires explicit resolved selection for a linked runtime root', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-history-linked-test-'));
		mkdirSync(join(root, 'old/data'), { recursive: true });
		mkdirSync(join(root, 'external'));
		symlinkSync(join(root, 'external'), join(root, 'old/data/assistant'));
		await expect(
			exportHistory({
				sourceHome: join(root, 'old'),
				image: String(image),
				destination: join(root, 'archive')
			})
		).rejects.toThrow();
	});
});
