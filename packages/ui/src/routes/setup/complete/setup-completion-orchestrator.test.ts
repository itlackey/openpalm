import { describe, expect, it } from 'bun:test';

const setupCompleteFile = new URL('./+server.ts', import.meta.url).pathname;

describe('setup/complete/+server.ts — shared completion orchestrator', () => {
	it('delegates setup completion through completeSetupOrchestration', async () => {
		const content = await Bun.file(setupCompleteFile).text();
		expect(content).toContain("import { completeSetupRouteResponse } from '$lib/server/setup-completion-response';");
		expect(content).toContain('SECRETS_ENV_PATH');
		expect(content).toContain('await completeSetupRouteResponse(setupManager, stackManager, SECRETS_ENV_PATH)');
		expect(content).not.toContain('completeSetupOrchestration(setupManager, stackManager');
	});
});
