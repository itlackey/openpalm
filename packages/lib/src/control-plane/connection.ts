import { readFileSync } from 'node:fs';

import { readCredentialKey } from './credential-store.js';
import { assistantEndpoint } from './opencode.js';
import { readStackConfig } from './stack-config.js';
import { requireInstall } from './state.js';
import { isCredentialUsername } from './stack-config.js';
import { stateSecretFile } from './foundation.js';

export type ConnectionDetails = {
	type: 'opencode' | 'mcp' | 'claude' | 'remote';
	url: string;
	username?: string;
	passwordFile?: string;
	password?: string;
	credential?: string;
	credentialKeyFile?: string;
	credentialKey?: string;
	extension?: string;
	note: string;
};

export type ConnectionDetailOptions = {
	credential?: string;
	showCredentialKey?: boolean;
	showAssistantPassword?: boolean;
	claudeExtension?: string;
};

function guardianEndpoint(bindAddress: string, port: number): string {
	const dialAddress =
		bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress === '::' ? '::1' : bindAddress;
	return `http://${dialAddress.includes(':') ? `[${dialAddress}]` : dialAddress}:${port}/mcp`;
}

function assistantPassword(homeDir: string): string {
	const value = readFileSync(stateSecretFile(homeDir, 'op_opencode_password'), 'utf8').replace(
		/[\r\n]+$/,
		''
	);
	if (!value) throw new Error('OpenCode password is empty.');
	return value;
}

export function connectionDetails(
	homeDir: string,
	type: ConnectionDetails['type'],
	options: ConnectionDetailOptions = {}
): ConnectionDetails {
	requireInstall(homeDir);
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	if (type === 'opencode') {
		return {
			type,
			url: assistantEndpoint(homeDir),
			username: 'opencode',
			passwordFile: stateSecretFile(homeDir, 'op_opencode_password'),
			...(options.showAssistantPassword ? { password: assistantPassword(homeDir) } : {}),
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
		...(options.showCredentialKey ? { credentialKey: readCredentialKey(homeDir, username) } : {})
	};
	if (type === 'claude') {
		return {
			type,
			...common,
			...(options.claudeExtension ? { extension: options.claudeExtension } : {}),
			note: 'Enable Guardian, install the MCPB, then enter this loopback URL and credential key.'
		};
	}
	return {
		type: 'mcp',
		...common,
		note: 'Use Streamable HTTP MCP and send the credential as Authorization: Bearer <key>.'
	};
}
