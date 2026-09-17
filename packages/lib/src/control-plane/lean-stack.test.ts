import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repository = join(import.meta.dir, '../../../..');

function asset(path: string): string {
	return readFileSync(join(repository, path), 'utf8');
}

describe('lean release surface', () => {
	it('ships one core service and only three optional profiles', () => {
		const compose = asset('packages/skeleton/system/stack/stack.compose.yml');
		const serviceBlock = compose.slice(
			compose.indexOf('services:'),
			compose.indexOf('\nnetworks:')
		);
		const services = [...serviceBlock.matchAll(/^ {2}([a-z][a-z0-9_-]+):$/gm)].map(
			(match) => match[1]
		);
		expect(services).toEqual(['assistant', 'guardian', 'discord', 'slack']);
		expect(compose).toContain('profiles: [gateway, discord, slack]');
		expect(compose).toContain('networks: [agent_net]');
		expect(compose).not.toMatch(/\b(?:voice|ollama|paperclip|tailscale|ui):/);
		expect(compose).not.toContain('/v1/chat/completions');
		expect(compose.match(/cap_drop: \[ALL\]/g)).toHaveLength(4);
		expect(compose.match(/no-new-privileges:true/g)).toHaveLength(4);
		expect(compose.match(/init: true/g)).toHaveLength(4);
		expect(compose.match(/OPENCODE_DISABLE_PROJECT_CONFIG: "true"/g)).toHaveLength(2);
		expect(compose).toContain('http://127.0.0.1:4096/config');
		expect(compose).toContain('host_ip: "${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}"');
		expect(compose).toContain('GUARDIAN_AUTH_DIR: /run/openpalm-credentials');
		expect(compose).toContain('${OP_HOME:?}/state/credentials:/run/openpalm-credentials:ro');
		expect(compose).toContain(
			'${OP_HOME:?}/state/credentials/${OP_DISCORD_CREDENTIAL:-discord}:/run/openpalm-credential:ro'
		);
		expect(compose).not.toContain('GUARDIAN_OWNER_POLICY:');
	});

	it('ships explicit Guardian chat, read, and full agent profiles', () => {
		const remote = asset('packages/skeleton/system/assistant/agents/remote.md');
		const read = asset('packages/skeleton/system/assistant/agents/remote-read.md');
		const full = asset('packages/skeleton/system/assistant/agents/remote-full.md');
		expect(remote).toContain('  "*": deny');
		expect(remote).toContain('Restricted agent used only by the Guardian MCP gateway');
		expect(read).toContain('  "*": deny');
		expect(read).toContain('  read:');
		expect(read).toContain('    "*.env": deny');
		expect(read).toContain('    "/stash/*": allow');
		expect(read).toContain('    "/stash/secrets/*": deny');
		expect(read).toContain('    "/stash/env/*": deny');
		expect(read).not.toContain('  grep: allow');
		expect(full).not.toContain('permission:');
		expect(full).toContain("Assistant's OpenCode permission configuration");
	});
});
