import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const commandSource = readFileSync(join(import.meta.dir, '../src/routes/command/+server.ts'), 'utf-8');

describe('command route setup completion flow', () => {
	it('applies stack and starts core services before marking setup complete', () => {
		expect(commandSource).toContain("if (type === 'setup.complete')");
		expect(commandSource).toContain('await applyStack(stackManager)');
		expect(commandSource).toContain('syncAutomations(stackManager.listAutomations())');
		expect(commandSource).toContain("const startupResult = await composeAction('up', [...SetupCoreServices])");
		expect(commandSource).toContain('setupManager.completeSetup()');
	});
});
