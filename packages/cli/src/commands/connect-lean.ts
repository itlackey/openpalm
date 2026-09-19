import { defineCommand } from 'citty';

import {
	assistantEndpoint,
	isCredentialUsername,
	readCredentialKey,
	readStackConfig,
	requireLeanInstall,
	resolveOpenPalmHome,
	stateSecretFile
} from '@openpalm/lib/lean';

import cliPackage from '../../package.json' with { type: 'json' };

export type ConnectionDetails = {
	type: 'opencode' | 'mcp' | 'claude' | 'remote';
	url: string;
	username?: string;
	passwordFile?: string;
	credential?: string;
	credentialKeyFile?: string;
	credentialKey?: string;
	extension?: string;
	note: string;
};

function guardianEndpoint(bindAddress: string, port: number): string {
	const dialAddress =
		bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress === '::' ? '::1' : bindAddress;
	return `http://${dialAddress.includes(':') ? `[${dialAddress}]` : dialAddress}:${port}/mcp`;
}

export function connectionDetails(
	homeDir: string,
	type: ConnectionDetails['type'],
	options: { credential?: string; showKey?: boolean } = {}
): ConnectionDetails {
	requireLeanInstall(homeDir);
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	if (type === 'opencode') {
		return {
			type,
			url: assistantEndpoint(homeDir),
			username: 'opencode',
			passwordFile: stateSecretFile(homeDir, 'op_opencode_password'),
			note: 'Trusted native access bypasses Guardian and should remain on loopback or a trusted private network.'
		};
	}
	if (type === 'remote') {
		return {
			type,
			url: 'https://your-public-host.example/mcp',
			note: 'Publish Guardian through trusted TLS termination and configure Guardian OAuth before adding this URL as a remote connector.'
		};
	}
	const username = options.credential ?? 'owner';
	if (!isCredentialUsername(username) || !Object.hasOwn(result.config.credentials, username)) {
		throw new Error(`Unknown credential: ${username}`);
	}
	const common = {
		url: guardianEndpoint(result.config.gateway.bindAddress, result.config.gateway.port),
		credential: username,
		credentialKeyFile: `${homeDir}/state/credentials/${username}/key`,
		...(options.showKey ? { credentialKey: readCredentialKey(homeDir, username) } : {})
	};
	if (type === 'claude') {
		return {
			type,
			...common,
			extension: `https://github.com/itlackey/openpalm/releases/download/${cliPackage.version}/openpalm-claude-desktop-${cliPackage.version}.mcpb`,
			note: 'Enable Guardian, install the MCPB, then enter this loopback URL and credential key.'
		};
	}
	return {
		type: 'mcp',
		...common,
		note: 'Use Streamable HTTP MCP and send the credential as Authorization: Bearer <key>.'
	};
}

export default defineCommand({
	meta: { name: 'connect', description: 'Show exact connection settings for a client' },
	args: {
		client: {
			type: 'positional',
			required: false,
			description: 'opencode, mcp, claude, or remote'
		},
		credential: { type: 'string', description: 'named Guardian credential (default: owner)' },
		showKey: { type: 'boolean', description: 'include the Guardian credential key' },
		json: { type: 'boolean', description: 'print machine-readable JSON' }
	},
	run({ args }) {
		const client = String(args._?.[0] ?? 'mcp');
		if (!['opencode', 'mcp', 'claude', 'remote'].includes(client)) {
			throw new Error('Client must be opencode, mcp, claude, or remote.');
		}
		const details = connectionDetails(resolveOpenPalmHome(), client as ConnectionDetails['type'], {
			credential: args.credential ? String(args.credential) : undefined,
			showKey: args.showKey === true
		});
		if (args.json) console.log(JSON.stringify(details, null, 2));
		else {
			console.log(`${details.type}: ${details.url}`);
			if (details.username) console.log(`Username: ${details.username}`);
			if (details.passwordFile) console.log(`Password file: ${details.passwordFile}`);
			if (details.credential) console.log(`Credential: ${details.credential}`);
			if (details.credentialKeyFile)
				console.log(`Credential key file: ${details.credentialKeyFile}`);
			if (details.credentialKey) console.log(`Credential key: ${details.credentialKey}`);
			if (details.extension) console.log(`Claude Desktop extension: ${details.extension}`);
			console.log(details.note);
		}
	}
});
