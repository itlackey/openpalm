#!/usr/bin/env -S bun --no-env-file
// Short-lived stdio client of Codex's native hook/config APIs. No model calls,
// plugin installation, blanket trust, or independent approval store.
import { createHash } from 'node:crypto';
import { remoteEnvironment } from './openpalm-remote.mjs';

export function recallReview(value) {
	if (!Array.isArray(value)) throw new Error('Invalid Codex hook inventory.');
	const hooks = value.filter((h) => h?.pluginId === 'akm@akm-plugins');
	if (!hooks.length || hooks.length > 16)
		throw new Error('AKM hooks are unavailable. Check the native Codex plugin installation.');
	const reviewed = hooks
		.map((h) => {
			if (
				h.source !== 'plugin' ||
				h.isManaged !== false ||
				h.handlerType !== 'command' ||
				typeof h.key !== 'string' ||
				h.key.length > 1024 ||
				!/^sha256:[a-f0-9]{64}$/.test(h.currentHash) ||
				typeof h.command !== 'string' ||
				h.command.length > 8192 ||
				typeof h.eventName !== 'string' ||
				typeof h.sourcePath !== 'string' ||
				typeof h.enabled !== 'boolean' ||
				!['trusted', 'untrusted', 'modified'].includes(h.trustStatus)
			)
				throw new Error('Unsupported AKM hook definition; native review is required.');
			return {
				key: h.key,
				hash: h.currentHash,
				event: h.eventName,
				command: h.command,
				sourcePath: h.sourcePath,
				enabled: h.enabled,
				trust: h.trustStatus
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key));
	if (new Set(reviewed.map((h) => h.key)).size !== reviewed.length)
		throw new Error('Duplicate AKM hook identity.');
	const digest = createHash('sha256').update(JSON.stringify(reviewed)).digest('hex');
	const status = reviewed.every((h) => !h.enabled)
		? 'installed'
		: reviewed.every((h) => h.enabled && h.trust === 'trusted')
			? 'ready'
			: 'approval-needed';
	return { status, digest, hooks: reviewed };
}

export async function reviewRecall(rpc) {
	const result = await rpc('hooks/list', { cwds: ['/work'] });
	if (!Array.isArray(result?.data) || result.data.length !== 1)
		throw new Error('Invalid Codex hook inventory.');
	if (result.data[0].errors?.length)
		throw new Error(
			'Native Codex reported hook configuration errors. Review its configuration first.'
		);
	return recallReview(result.data[0].hooks);
}

export async function changeRecall(rpc, action, digest) {
	if (!['approve', 'disable'].includes(action) || !/^[a-f0-9]{64}$/.test(digest))
		throw new Error('Review the current AKM hooks and explicitly approve your choice first.');
	const config = await rpc('config/read', { includeLayers: true, cwd: '/work' });
	const layer = config.layers?.find((l) => l.name?.type === 'user' && l.name.profile === null);
	if (!layer || typeof layer.version !== 'string')
		throw new Error('Native Codex user configuration is unavailable.');
	const review = await reviewRecall(rpc);
	if (digest !== review.digest)
		throw new Error('AKM hooks changed since review. Review the current definitions again.');
	const edits = review.hooks.flatMap((h) => {
		const key = `hooks.state.${JSON.stringify(h.key)}`;
		return action === 'disable'
			? [{ keyPath: `${key}.enabled`, value: false, mergeStrategy: 'replace' }]
			: [
					{ keyPath: `${key}.trusted_hash`, value: h.hash, mergeStrategy: 'replace' },
					{ keyPath: `${key}.enabled`, value: true, mergeStrategy: 'replace' }
				];
	});
	const result = await rpc('config/batchWrite', { edits, expectedVersion: layer.version });
	if (result.overriddenMetadata)
		throw new Error('Native policy overrides recall. Review your Codex configuration.');
	return reviewRecall(rpc);
}

export async function withCodexRecall(
	callback,
	{ env = process.env, workdir = '/work', timeoutMs = 12_000 } = {}
) {
	const child = Bun.spawn(['codex', 'app-server'], {
		cwd: workdir,
		env: remoteEnvironment(env),
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'ignore'
	});
	const pending = new Map();
	let serial = 0;
	let stopped;
	const fail = () => {
		stopped = new Error(
			'Codex hook review failed or timed out. Check native configuration and update Assistant.'
		);
		for (const p of pending.values()) p.reject(stopped);
		pending.clear();
		child.kill();
	};
	const timer = setTimeout(fail, timeoutMs);
	const reader = (async () => {
		let buffer = '';
		const decoder = new TextDecoder();
		try {
			for await (const chunk of child.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				if (buffer.length > 1_048_576) throw new Error('Invalid native output');
				while (buffer.includes('\n')) {
					const end = buffer.indexOf('\n');
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					const response = JSON.parse(line);
					const item = pending.get(response.id);
					if (!item) continue;
					pending.delete(response.id);
					if (response.error)
						item.reject(
							new Error('Native Codex rejected the hook configuration change; review again.')
						);
					else item.resolve(response.result);
				}
			}
		} catch {
			fail();
		}
		if (pending.size) fail();
	})();
	const rpc = (method, params) =>
		new Promise((resolve, reject) => {
			if (stopped) return reject(stopped);
			const id = ++serial;
			pending.set(id, { resolve, reject });
			try {
				child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
				child.stdin.flush();
			} catch {
				fail();
			}
		});
	try {
		await rpc('initialize', { clientInfo: { name: 'openpalm-recall-setup', version: '1' } });
		child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
		child.stdin.flush();
		return await callback(rpc);
	} finally {
		clearTimeout(timer);
		child.kill();
		const force = setTimeout(() => child.kill('SIGKILL'), 2000);
		try {
			await child.exited;
			await reader;
		} finally {
			clearTimeout(force);
		}
	}
}

if (import.meta.main) {
	try {
		const action = process.argv[2] ?? 'review';
		const result = await withCodexRecall((rpc) =>
			action === 'review' ? reviewRecall(rpc) : changeRecall(rpc, action, process.argv[3])
		);
		console.log(JSON.stringify(result));
	} catch (error) {
		console.log(JSON.stringify({ error: error.message }));
		process.exitCode = 1;
	}
}
