import { describe, expect, it } from 'bun:test';

const commandFile = new URL('./+server.ts', import.meta.url).pathname;

describe('command/+server.ts — setup flow safeguards', () => {
	it('setup.complete delegates to shared completion orchestrator', async () => {
		const content = await Bun.file(commandFile).text();
		expect(content).toContain("import { completeSetupCommandResponse } from '$lib/server/setup-completion-response';");
		expect(content).toContain('SECRETS_ENV_PATH');
		expect(content).toContain('await completeSetupCommandResponse(setupManager, stackManager, SECRETS_ENV_PATH)');
		expect(content).not.toContain('completeSetupOrchestration(setupManager, stackManager');
	});

	it('does not expose setup.start_core detached startup command path', async () => {
		const content = await Bun.file(commandFile).text();
		expect(content).not.toContain("if (type === 'setup.start_core')");
		expect(content).not.toContain("return json(200, { ok: true, status: 'starting' })");
		expect(content).not.toContain('Promise.allSettled(services.map((svc) => composePull(svc)))');
		expect(content).not.toContain("log.error('Core startup failed'");
	});

	it('setup.channels updates stack spec enabled flags', async () => {
		const content = await Bun.file(commandFile).text();
		expect(content).toContain("const spec = stackManager.getSpec();");
		expect(content).toContain('spec.channels[channelName].enabled = channels.includes(service)');
		expect(content).toContain('stackManager.setSpec(spec)');
	});

	it('service lifecycle handlers fail when composeAction returns ok=false', async () => {
		const content = await Bun.file(commandFile).text();
		expect(content).toContain("if (!result.ok) throw new Error(result.stderr || 'service_up_failed')");
		expect(content).toContain("if (!result.ok) throw new Error(result.stderr || 'service_stop_failed')");
		expect(content).toContain("if (!result.ok) throw new Error(result.stderr || 'service_restart_failed')");
	});
});
