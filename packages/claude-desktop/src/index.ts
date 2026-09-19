#!/usr/bin/env node

import {
	StreamableHTTPClientTransport,
	type JSONRPCMessage
} from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_RE = /^[\x21-\x7e]{32,512}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type BridgeConfiguration = {
	url: URL;
	token: string;
};

export function readBridgeConfiguration(
	environment: Record<string, string | undefined> = process.env
): BridgeConfiguration {
	const rawUrl = environment.OPENPALM_MCP_URL?.trim() || 'http://127.0.0.1:3830/mcp';
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error('OPENPALM_MCP_URL must be a valid URL.');
	}
	if (
		url.protocol !== 'http:' ||
		!LOOPBACK_HOSTS.has(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/mcp'
	) {
		throw new Error('OPENPALM_MCP_URL must be an HTTP loopback URL ending in /mcp.');
	}
	const token = environment.OPENPALM_MCP_TOKEN ?? '';
	if (!TOKEN_RE.test(token)) {
		throw new Error('OPENPALM_MCP_TOKEN must contain a valid OpenPalm credential key.');
	}
	return { url, token };
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number } {
	return 'id' in message && 'method' in message;
}

function publicError(error: unknown): string {
	if (error instanceof Error && error.name === 'UnauthorizedError') {
		return 'OpenPalm rejected the configured credential.';
	}
	return 'OpenPalm Guardian is unavailable or rejected the request.';
}

export async function runBridge(configuration = readBridgeConfiguration()): Promise<void> {
	const local = new StdioServerTransport(process.stdin, process.stdout, {
		maxBufferSize: 10 * 1024 * 1024
	});
	const remote = new StreamableHTTPClientTransport(configuration.url, {
		authProvider: { token: async () => configuration.token }
	});
	let closing = false;

	const close = async () => {
		if (closing) return;
		closing = true;
		await Promise.allSettled([local.close(), remote.close()]);
	};

	local.onmessage = (message) => {
		void remote.send(message).catch(async (error: unknown) => {
			if (isRequest(message)) {
				await local
					.send({
						jsonrpc: '2.0',
						id: message.id,
						error: { code: -32603, message: publicError(error) }
					})
					.catch(() => {});
			}
		});
	};
	remote.onmessage = (message) => {
		void local.send(message).catch(() => close());
	};
	local.onerror = (error) => console.error(`OpenPalm MCP input error: ${error.message}`);
	remote.onerror = (error) => console.error(`OpenPalm Guardian connection error: ${error.message}`);
	local.onclose = () => void close();
	remote.onclose = () => void close();
	process.stdin.once('end', () => void close());
	process.once('SIGINT', () => void close());
	process.once('SIGTERM', () => void close());

	await remote.start();
	await local.start();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	runBridge().catch((error) => {
		console.error(error instanceof Error ? error.message : 'OpenPalm MCP bridge failed.');
		process.exitCode = 1;
	});
}
