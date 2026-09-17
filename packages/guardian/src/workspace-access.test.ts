import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkspaceAccess, WorkspaceAccessError } from './workspace-access.js';

const temporary: string[] = [];

async function fixture() {
	const parent = await mkdtemp(join(tmpdir(), 'openpalm-workspace-'));
	temporary.push(parent);
	const root = join(parent, 'work');
	await mkdir(join(root, 'src'), { recursive: true });
	await writeFile(join(root, 'src', 'index.ts'), 'export const safe = true;\n');
	await writeFile(join(root, 'unicode.txt'), 'aéz');
	await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
	const outside = join(parent, 'outside.txt');
	await writeFile(outside, 'must not escape\n');
	await symlink(outside, join(root, 'escape.txt'));
	return { root, access: createWorkspaceAccess(root) };
}

afterEach(async () => {
	for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('workspace filesystem boundary', () => {
	it('reads a bounded regular UTF-8 file inside the workspace', async () => {
		const { access } = await fixture();
		const file = await access.readText('src/index.ts', 1_024, AbortSignal.timeout(1_000));
		expect(file).toEqual({
			text: 'export const safe = true;\n',
			mimeType: 'text/javascript',
			truncated: false
		});
		expect(await access.readText('unicode.txt', 2, AbortSignal.timeout(1_000))).toEqual({
			text: 'a',
			mimeType: 'text/plain',
			truncated: true
		});
	});

	it('fails closed for symlink escapes and non-text files', async () => {
		const { access } = await fixture();
		expect(await access.allows('escape.txt', AbortSignal.timeout(1_000))).toBe(false);
		expect(access.readText('escape.txt', 1_024, AbortSignal.timeout(1_000))).rejects.toBeInstanceOf(
			WorkspaceAccessError
		);
		expect(access.readText('binary.dat', 1_024, AbortSignal.timeout(1_000))).rejects.toMatchObject({
			code: 'not_text'
		});
	});
});
