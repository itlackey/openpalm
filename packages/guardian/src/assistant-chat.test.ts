import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAssistantChatClient } from './assistant-chat.js';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Assistant chat client', () => {
	it('sends only a validated managed agent name in the OpenCode message body', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-assistant-chat-'));
		roots.push(root);
		const passwordFile = join(root, 'password');
		writeFileSync(passwordFile, `${'p'.repeat(32)}\n`);
		let body: unknown;
		const client = createAssistantChatClient({
			baseUrl: 'http://assistant:4096',
			passwordFile,
			fetch: async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return Response.json({ parts: [{ type: 'text', text: 'ok' }] });
			}
		});

		const signal = new AbortController().signal;
		expect(await client.sendMessage('session_1', 'inspect', 'remote-read', signal)).toBe('ok');
		expect(body).toEqual({
			agent: 'remote-read',
			parts: [{ type: 'text', text: 'inspect' }]
		});
		await expect(
			client.sendMessage('session_1', 'inspect', '../../operator', signal)
		).rejects.toThrow('invalid assistant agent');
	});
});
