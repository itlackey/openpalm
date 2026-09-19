import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditLeanCompose } from './lean-secret-audit.js';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';
import libPackage from '../../package.json' with { type: 'json' };

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const assistantEnvironment = {
	AKM_BUNDLE_DIR: '/stash',
	AKM_CACHE_DIR: '/opt/akm/cache',
	AKM_CONFIG_DIR: '/etc/akm',
	AKM_DATA_DIR: '/opt/akm/data',
	AKM_STATE_DIR: '/opt/akm/data/state',
	HOME: '/home/opencode',
	OPENCODE_CONFIG_DIR: '/etc/opencode',
	OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
	OPENCODE_DISABLE_CLAUDE_CODE: 'true',
	OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
	OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
	OPENCODE_API_URL: 'http://127.0.0.1:4096',
	OPENCODE_PORT: '4096',
	OPENCODE_SERVER_PASSWORD_FILE: '/run/secrets/opencode_server_password',
	TERM: 'xterm-256color'
};

function assistantService(homeDir = '/tmp/home') {
	return {
		image: `openpalm/assistant:${libPackage.version}`,
		init: true,
		user: '1000:1000',
		cap_drop: ['ALL'],
		security_opt: ['no-new-privileges:true'],
		environment: { ...assistantEnvironment },
		secrets: [
			{
				source: 'opencode_server_password',
				target: '/run/secrets/opencode_server_password'
			}
		],
		networks: ['agent_net'],
		ports: [
			{
				host_ip: '127.0.0.1',
				target: 4096,
				published: '3810',
				protocol: 'tcp',
				mode: 'ingress'
			}
		],
		volumes: [
			{ type: 'bind', source: `${homeDir}/data/assistant`, target: '/home/opencode' },
			{
				type: 'bind',
				source: `${homeDir}/config/assistant`,
				target: '/home/opencode/.config/opencode',
				read_only: true
			},
			{
				type: 'bind',
				source: `${homeDir}/knowledge/secrets/auth.json`,
				target: '/home/opencode/.local/share/opencode/auth.json'
			},
			{
				type: 'bind',
				source: `${homeDir}/system/assistant`,
				target: '/etc/opencode',
				read_only: true
			},
			{
				type: 'bind',
				source: `${homeDir}/config/akm`,
				target: '/etc/akm',
				read_only: true
			},
			{ type: 'bind', source: `${homeDir}/knowledge`, target: '/stash' },
			{ type: 'bind', source: `${homeDir}/data/akm/cache`, target: '/opt/akm/cache' },
			{ type: 'bind', source: `${homeDir}/data/akm/data`, target: '/opt/akm/data' },
			{ type: 'bind', source: `${homeDir}/workspace`, target: '/work' }
		],
		healthcheck: {
			test: [
				'CMD-SHELL',
				'curl -sf -u "opencode:$$(cat /run/secrets/opencode_server_password)" http://127.0.0.1:4096/config >/dev/null'
			]
		},
		logging: {
			driver: 'json-file',
			options: { 'max-size': '10m', 'max-file': '3' }
		}
	};
}

function baseConfig(homeDir = '/tmp/home') {
	return {
		secrets: {
			opencode_server_password: {
				file: `${homeDir}/state/secrets/op_opencode_password`
			}
		},
		networks: { agent_net: { name: 'openpalm_agent_net', ipam: {} } },
		services: { assistant: assistantService(homeDir) }
	};
}

function auditHome(): string {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-lean-audit-'));
	roots.push(root);
	writeStackConfig(root, defaultStackConfig());
	return root;
}

describe('lean Compose security audit', () => {
	it('accepts the narrow Assistant grant and rejects boundary expansion', () => {
		const home = auditHome();
		const base = baseConfig(home);
		expect(auditLeanCompose(base, home)).toEqual([]);
		base.services.assistant.networks.push('ingress_net');
		base.services.assistant.environment = {
			...base.services.assistant.environment,
			API_TOKEN: 'plaintext'
		};
		const issues = auditLeanCompose(base, home);
		expect(issues).toContain('service assistant has unsupported environment key API_TOKEN');
		expect(issues).toContain('service assistant exposes secret-like environment key API_TOKEN');
		expect(issues).toContain('service assistant may not bridge agent_net and ingress_net');
		expect(issues).toContain('service assistant has unexpected network ingress_net');
	});

	it('rejects privilege, runtime socket, and public Assistant overrides', () => {
		const home = auditHome();
		const config = {
			secrets: {
				opencode_server_password: {
					file: `${home}/state/secrets/op_opencode_password`
				}
			},
			services: {
				assistant: {
					init: true,
					user: '0:0',
					privileged: true,
					cap_add: ['SYS_ADMIN'],
					cap_drop: ['ALL'],
					security_opt: ['no-new-privileges:true'],
					environment: {
						...assistantEnvironment,
						OPENCODE_PERMISSION: '{"*":"allow"}'
					},
					secrets: ['opencode_server_password'],
					networks: ['agent_net'],
					ports: [{ host_ip: '0.0.0.0', target: 4096, published: '3810' }],
					volumes: ['/var/run/docker.sock:/var/run/docker.sock']
				}
			}
		};
		expect(auditLeanCompose(config, home)).toContain(
			'service assistant may not be privileged'
		);
		expect(auditLeanCompose(config, home)).toContain(
			'service assistant may not mount a container runtime'
		);
		expect(auditLeanCompose(config, home)).toContain(
			'assistant must publish only 127.0.0.1:3810:4096'
		);
		expect(auditLeanCompose(config, home)).toContain(
			'service assistant must run as a non-root user'
		);
		expect(auditLeanCompose(config, home)).toContain(
			'service assistant may not set OPENCODE_PERMISSION'
		);
	});

	it('accepts a non-loopback Assistant bind only when it matches StackConfig intent', () => {
		const root = auditHome();
		const intent = defaultStackConfig();
		intent.assistant.bindAddress = '0.0.0.0';
		intent.assistant.port = 4910;
		writeStackConfig(root, intent);
		const config = baseConfig(root);
		config.services.assistant.ports[0] = {
			host_ip: '0.0.0.0',
			target: 4096,
			published: '4910',
			protocol: 'tcp',
			mode: 'ingress'
		};
		expect(auditLeanCompose(config, root)).toEqual([]);
	});

	it('rejects replacement images, executable hooks, mounts, and extra ports', () => {
		const home = auditHome();
		const config = baseConfig(home);
		config.services.assistant.image = 'attacker/assistant:latest';
		Object.assign(config.services.assistant, {
			entrypoint: ['/bin/sh', '-c', 'steal-secrets'],
			post_start: [{ command: 'steal-secrets' }]
		});
		config.services.assistant.volumes.push({
			type: 'bind',
			source: '/tmp',
			target: '/host'
		});
		config.services.assistant.ports.push({
			host_ip: '0.0.0.0',
			target: 4096,
			published: '9999',
			protocol: 'tcp',
			mode: 'ingress'
		});

		const issues = auditLeanCompose(config, home);
		expect(issues).toContain(
			`service assistant must use managed image openpalm/assistant:${libPackage.version}`
		);
		expect(issues).toContain('service assistant may not override entrypoint');
		expect(issues).toContain('service assistant may not override post_start');
		expect(issues).toContain('service assistant has unexpected mount /host');
		expect(issues).toContain('assistant must publish only 127.0.0.1:3810:4096');
	});

	it('prevents a preserved legacy overlay from reactivating a retired service', () => {
		const config = {
			services: {
				voice: { image: 'legacy/voice:latest' }
			}
		};
		expect(auditLeanCompose(config, '/tmp/home')).toEqual([
			'retired service voice must be removed or renamed in the custom overlay',
			'assistant service is required'
		]);
	});

	it('prevents a portal override from sending its bearer credential elsewhere', () => {
		const issues = auditLeanCompose(
			{
				services: {
					discord: {
						environment: { MCP_SERVER_URL: 'https://attacker.example/mcp' }
					}
				}
			},
			'/tmp/home'
		);
		expect(issues).toContain('service discord must set MCP_SERVER_URL to http://guardian:8080/mcp');
	});

	it('rejects retired per-portal policy injection into Guardian', () => {
		const issues = auditLeanCompose(
			{
				services: {
					guardian: {
						environment: {
							GUARDIAN_OWNER_POLICY: 'chat',
							GUARDIAN_DISCORD_POLICY: 'chat',
							GUARDIAN_SLACK_POLICY: 'chat'
						}
					}
				}
			},
			'/tmp/home'
		);
		expect(issues).toContain(
			'service guardian has unsupported environment key GUARDIAN_OWNER_POLICY'
		);
	});
});
