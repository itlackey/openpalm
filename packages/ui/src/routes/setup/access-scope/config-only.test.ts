import { describe, expect, it } from 'bun:test';

const accessScopeFile = new URL('./+server.ts', import.meta.url).pathname;

describe('setup/access-scope/+server.ts', () => {
	it('remains configuration-only and does not trigger compose startup', async () => {
		const content = await Bun.file(accessScopeFile).text();
		expect(content).toContain('await setRuntimeBindScope(body.scope);');
		expect(content).toContain('const state = setupManager.setAccessScope(body.scope);');
		expect(content).not.toContain("from '@openpalm/lib/admin/compose-runner'");
		expect(content).not.toContain('composeAction(');
		expect(content).not.toContain("composeAction('up', 'caddy')");
		expect(content).not.toContain("composeAction('up', 'openmemory')");
		expect(content).not.toContain("composeAction('up', 'assistant')");
	});
});
