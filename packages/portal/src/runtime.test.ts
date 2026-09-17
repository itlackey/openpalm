import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from './conversations.js';
import { ConversationQueue } from './queue.js';
import { isAllowed, splitMessage } from './runtime.js';

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('portal core', () => {
	it('is default-deny and requires every configured scope to match', () => {
		expect(isAllowed({ userId: 'u1', scopes: [{ allowed: new Set(), actual: ['u1'] }] })).toBe(
			false
		);
		expect(
			isAllowed({
				userId: 'u1',
				scopes: [
					{ allowed: new Set(['u1']), actual: ['u1'] },
					{ allowed: new Set(['c1']), actual: ['c1'] }
				]
			})
		).toBe(true);
		expect(
			isAllowed({
				userId: 'u1',
				scopes: [
					{ allowed: new Set(['u1']), actual: ['u1'] },
					{ allowed: new Set(['c2']), actual: ['c1'] }
				]
			})
		).toBe(false);
	});

	it('persists only opaque conversation handles', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-portal-'));
		temporaryPaths.push(root);
		const path = join(root, 'portal.db');
		const first = new ConversationStore(path);
		first.set('discord', 'thread:1', 'opaque.handle');
		first.close();
		const second = new ConversationStore(path);
		expect(second.get('discord', 'thread:1')).toBe('opaque.handle');
		second.clear('discord', 'thread:1');
		expect(second.get('discord', 'thread:1')).toBeUndefined();
		second.close();
	});

	it('splits platform messages without losing text', () => {
		const text = `${'a'.repeat(12)}\n${'b'.repeat(12)}`;
		expect(splitMessage(text, 15).join('')).toBe(text.replace('\n', ''));
	});

	it('bounds queued conversations and per-conversation backlog', async () => {
		const queue = new ConversationQueue(1, 1);
		let release: (() => void) | undefined;
		const first = queue.run('a', () => new Promise<void>((resolve) => (release = resolve)));
		await Promise.resolve();
		await expect(queue.run('a', async () => {})).rejects.toThrow('conversation queue is busy');
		await expect(queue.run('b', async () => {})).rejects.toThrow('portal queue is busy');
		release?.();
		await first;
	});
});
