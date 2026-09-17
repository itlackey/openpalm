import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAssistantClient } from './assistant-client.js';

const temporary: string[] = [];

afterEach(async () => {
	for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('OpenCode Assistant adapter', () => {
	it('sends an exact async message ID with fresh file-backed Basic auth', async () => {
		const root = await mkdtemp(join(tmpdir(), 'openpalm-assistant-client-'));
		temporary.push(root);
		const passwordFile = join(root, 'password');
		await writeFile(passwordFile, 'first-password');
		const requests: Request[] = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			requests.push(request.clone());
			const url = new URL(request.url);
			if (url.pathname === '/session/ses_1/prompt_async') {
				return new Response(null, { status: 204 });
			}
			if (url.pathname === '/session/ses_1/message') {
				return Response.json([
					{
						info: {
							id: 'msg_answer',
							sessionID: 'ses_1',
							role: 'assistant',
							parentID: 'msg_request',
							time: { created: 20, completed: 30 },
							modelID: 'model',
							providerID: 'provider',
							mode: 'remote-full',
							agent: 'remote-full',
							path: { cwd: '/work', root: '/work' },
							cost: 0.01,
							tokens: {
								input: 2,
								output: 3,
								reasoning: 0,
								cache: { read: 0, write: 0 }
							}
						},
						parts: [
							{
								id: 'prt_text',
								sessionID: 'ses_1',
								messageID: 'msg_answer',
								type: 'text',
								text: 'done'
							},
							{
								id: 'prt_patch',
								sessionID: 'ses_1',
								messageID: 'msg_answer',
								type: 'patch',
								hash: 'hash',
								files: ['src/index.ts']
							}
						]
					}
				]);
			}
			return Response.json({ error: 'unexpected request' }, { status: 500 });
		};
		const client = createAssistantClient({
			baseUrl: 'http://assistant:4096',
			directory: '/work',
			passwordFile,
			fetch: fakeFetch
		});

		await client.runAsync(
			'ses_1',
			'msg_request',
			'do the work',
			'remote-full',
			AbortSignal.timeout(1_000)
		);
		const submitted = requests[0];
		expect(submitted.headers.get('x-opencode-directory')).toBe('%2Fwork');
		expect(submitted.headers.get('authorization')).toBe(
			`Basic ${Buffer.from('opencode:first-password').toString('base64')}`
		);
		expect(await submitted.json()).toMatchObject({
			messageID: 'msg_request',
			agent: 'remote-full',
			parts: [{ type: 'text', text: 'do the work' }]
		});

		await writeFile(passwordFile, 'rotated-password');
		expect(await client.listMessages('ses_1', 20, AbortSignal.timeout(1_000))).toEqual([
			expect.objectContaining({
				id: 'msg_answer',
				parentId: 'msg_request',
				role: 'assistant',
				text: 'done',
				files: ['src/index.ts']
			})
		]);
		expect(requests[1]?.headers.get('authorization')).toBe(
			`Basic ${Buffer.from('opencode:rotated-password').toString('base64')}`
		);
		expect(new URL(requests[1]?.url ?? '').searchParams.get('directory')).toBe('/work');
	});
});
