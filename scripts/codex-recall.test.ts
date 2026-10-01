import { describe, expect, it } from 'bun:test';
import {
	changeRecall,
	recallReview,
	reviewRecall
} from '../containers/assistant/openpalm-codex-recall.mjs';

const hook = (event = 'sessionStart') => ({
	key: `akm@akm-plugins:${event}`,
	currentHash: `sha256:${'a'.repeat(64)}`,
	eventName: event,
	command: 'sh /installed/akm-hook.sh session-start',
	sourcePath: '/installed/.codex-plugin/plugin.json',
	source: 'plugin',
	pluginId: 'akm@akm-plugins',
	handlerType: 'command',
	isManaged: false,
	enabled: true,
	trustStatus: 'untrusted'
});

describe('native Codex recall review', () => {
	it('reports approval, ready and installed states without trusting unrelated hooks', () => {
		const unrelated = {
			...hook(),
			pluginId: 'other@market',
			key: 'unrelated',
			trustStatus: 'untrusted'
		};
		expect(recallReview([hook(), unrelated])).toMatchObject({
			status: 'approval-needed',
			hooks: [{ key: hook().key }]
		});
		expect(recallReview([{ ...hook(), trustStatus: 'trusted' }]).status).toBe('ready');
		expect(recallReview([{ ...hook(), enabled: false }]).status).toBe('installed');
		expect(recallReview([{ ...hook(), trustStatus: 'modified' }]).status).toBe('approval-needed');
		expect(() => recallReview([])).toThrow('unavailable');
		for (const malformed of [
			{ source: 'system' },
			{ isManaged: true },
			{ handlerType: 'prompt' },
			{ currentHash: 'bad' },
			{ enabled: 'yes' }
		])
			expect(() => recallReview([{ ...hook(), ...malformed }])).toThrow('Unsupported');
		expect(() => recallReview([hook(), hook()])).toThrow('Duplicate');
	});
	it('binds approval to the exact review and uses only version-checked native config edits', async () => {
		let hooks = [hook(), hook('userPromptSubmit')];
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const rpc = async (method: string, params: Record<string, unknown>) => {
			calls.push({ method, params });
			if (method === 'hooks/list')
				return { data: [{ hooks: [...hooks, { ...hook(), pluginId: 'unrelated' }] }] };
			if (method === 'config/read')
				return { layers: [{ name: { type: 'user', profile: null }, version: 'native-version' }] };
			if (method === 'config/batchWrite') {
				hooks = hooks.map((h) => ({ ...h, trustStatus: 'trusted' }));
				return {};
			}
			throw new Error('Unexpected RPC');
		};
		const review = await reviewRecall(rpc);
		expect(await changeRecall(rpc, 'approve', review.digest)).toMatchObject({ status: 'ready' });
		const write = calls.find((c) => c.method === 'config/batchWrite');
		if (!write) throw new Error('Native config write was not called');
		expect(write.params).toMatchObject({ expectedVersion: 'native-version' });
		expect(write.params.edits).toEqual(
			hooks.flatMap((h) => [
				{
					keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`,
					value: h.currentHash,
					mergeStrategy: 'replace'
				},
				{
					keyPath: `hooks.state.${JSON.stringify(h.key)}.enabled`,
					value: true,
					mergeStrategy: 'replace'
				}
			])
		);
		calls.length = 0;
		await expect(changeRecall(rpc, 'approve', review.digest)).rejects.toThrow(
			'changed since review'
		);
		expect(calls.some((c) => c.method === 'config/batchWrite')).toBe(false);
		await expect(changeRecall(rpc, 'approve', '')).rejects.toThrow('explicitly approve');
	});
	it('disables without changing trust and propagates native write conflicts/config errors', async () => {
		const review = recallReview([hook()]);
		const rpc = async (method: string, params: Record<string, unknown>) => {
			if (method === 'hooks/list') return { data: [{ hooks: [hook()] }] };
			if (method === 'config/read')
				return { layers: [{ name: { type: 'user', profile: null }, version: 'v' }] };
			expect(params.edits).toEqual([
				{
					keyPath: `hooks.state.${JSON.stringify(hook().key)}.enabled`,
					value: false,
					mergeStrategy: 'replace'
				}
			]);
			throw new Error('Native version conflict');
		};
		await expect(changeRecall(rpc, 'disable', review.digest)).rejects.toThrow('version conflict');
		await expect(
			reviewRecall(async () => ({ data: [{ hooks: [hook()], errors: ['bad definition'] }] }))
		).rejects.toThrow('configuration errors');
	});
});
