import { describe, expect, it } from 'bun:test';

const commandFile = new URL('./+server.ts', import.meta.url).pathname;

function getHandlerBlock(content: string, type: string): string {
	const startMarker = `if (type === '${type}')`;
	const start = content.indexOf(startMarker);
	if (start < 0) return '';
	const next = content.indexOf("\n\t\tif (type === '", start + startMarker.length);
	return next < 0 ? content.slice(start) : content.slice(start, next);
}

describe('command/+server.ts — setup flow safeguards', () => {
	it('setup.complete delegates to shared completion orchestrator', async () => {
		const content = await Bun.file(commandFile).text();
		const setupCompleteHandler = getHandlerBlock(content, 'setup.complete');
		expect(content).toContain("import { completeSetupCommandResponse } from '$lib/server/setup-completion-response';");
		expect(content).toContain('SECRETS_ENV_PATH');
		expect(content).toContain('await completeSetupCommandResponse(setupManager, stackManager, SECRETS_ENV_PATH)');
		expect(setupCompleteHandler).not.toContain("composeAction('up'");
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

	it('keeps setup.access_scope and setup.profile configuration-only', async () => {
		const content = await Bun.file(commandFile).text();

		const accessScopeHandler = getHandlerBlock(content, 'setup.access_scope');
		expect(accessScopeHandler).toContain('await setRuntimeBindScope(scope);');
		expect(accessScopeHandler).toContain(
			'return json(200, { ok: true, data: setupManager.setAccessScope(scope) });'
		);
		expect(accessScopeHandler).not.toContain("composeAction('up', 'assistant')");
		expect(accessScopeHandler).not.toContain("composeAction('up', 'openmemory')");
		expect(accessScopeHandler).not.toContain("composeAction('up', 'caddy')");

		const profileHandler = getHandlerBlock(content, 'setup.profile');
		expect(profileHandler).toContain('await updateDataEnv({');
		expect(profileHandler).toContain("upsertEnvVar(RUNTIME_ENV_PATH, 'ADMIN_TOKEN', password)");
		expect(profileHandler).toContain('stackManager.renderArtifacts();');
		expect(profileHandler).not.toContain("composeAction('up', 'assistant')");
		expect(profileHandler).not.toContain("composeAction('up', 'openmemory')");
		expect(profileHandler).not.toContain("composeAction('up', 'caddy')");
		expect(profileHandler).not.toContain('.catch(() => {})');
	});

	it('service lifecycle handlers fail when composeAction returns ok=false', async () => {
		const content = await Bun.file(commandFile).text();
		expect(content).toContain("if (!result.ok) throw new Error(result.stderr || 'service_up_failed')");
		expect(content).toContain("if (!result.ok) throw new Error(result.stderr || 'service_stop_failed')");
		expect(content).toContain("if (!result.ok) throw new Error(result.stderr || 'service_restart_failed')");
	});
});
