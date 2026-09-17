import { describe, expect, it } from 'bun:test';

import { filterWorkspacePaths, workspacePath, workspaceQuery } from './workspace-policy.js';

describe('workspace policy', () => {
	it('accepts ordinary relative paths and rejects traversal or absolute paths', () => {
		expect(workspacePath('src/index.ts')).toEqual({ ok: true, path: 'src/index.ts' });
		expect(workspacePath('../secret')).toEqual({ ok: false, error: 'invalid_path' });
		expect(workspacePath('/etc/passwd')).toEqual({ ok: false, error: 'invalid_path' });
		expect(workspacePath('src\\index.ts')).toEqual({ ok: false, error: 'invalid_path' });
	});

	it('denies secret-like files and directories while allowing examples', () => {
		expect(workspacePath('.env')).toEqual({ ok: false, error: 'restricted_path' });
		expect(workspacePath('config/auth.json')).toEqual({
			ok: false,
			error: 'restricted_path'
		});
		expect(workspacePath('fixtures/.env.example')).toEqual({
			ok: true,
			path: 'fixtures/.env.example'
		});
	});

	it('bounds queries and filters restricted search results', () => {
		expect(workspaceQuery('  needle  ')).toBe('needle');
		expect(workspaceQuery('')).toBeNull();
		expect(filterWorkspacePaths(['src/a.ts', '.env', 'src/b.ts'], 2)).toEqual([
			'src/a.ts',
			'src/b.ts'
		]);
	});
});
