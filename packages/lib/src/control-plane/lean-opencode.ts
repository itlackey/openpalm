import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readStackConfig } from './stack-config.js';
import { stateSecretFile } from './lean-foundation.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const READY_TOKEN = 'OPENPALM_READY';

export type ProviderSummary = {
	id: string;
	name: string;
	source: string;
	modelCount: number;
	connected: boolean;
	authenticated: boolean;
	authMethods: Array<{ type: 'oauth' | 'api'; label: string }>;
};

export type AssistantReadiness =
	| { ok: true; response: string; provider?: string; model?: string }
	| { ok: false; error: string };

type FetchLike = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function dialAddress(address: string): string {
	if (address === '0.0.0.0') return '127.0.0.1';
	if (address === '::') return '::1';
	return address;
}

export function assistantEndpoint(homeDir: string): string {
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	const address = dialAddress(result.config.assistant.bindAddress);
	return `http://${address.includes(':') ? `[${address}]` : address}:${result.config.assistant.port}`;
}

function assistantAuthorization(homeDir: string): string {
	const path = stateSecretFile(homeDir, 'op_opencode_password');
	if (!existsSync(path)) throw new Error(`OpenCode password is missing: ${path}`);
	const password = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
	if (!password) throw new Error('OpenCode password is empty');
	return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

async function responseJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
		throw new Error('OpenCode response exceeded the size limit');
	}
	const text = await response.text();
	if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
		throw new Error('OpenCode response exceeded the size limit');
	}
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error('OpenCode returned an invalid response');
	}
}

function errorMessage(value: unknown, status: number): string {
	const root = asRecord(value);
	const data = asRecord(root?.data);
	const message =
		(typeof root?.message === 'string' && root.message) ||
		(typeof data?.message === 'string' && data.message) ||
		(typeof root?.name === 'string' && root.name) ||
		`OpenCode returned HTTP ${status}`;
	return message.slice(0, 500);
}

async function request(
	homeDir: string,
	path: string,
	init: RequestInit = {},
	options: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<unknown> {
	const headers = new Headers(init.headers);
	headers.set('authorization', assistantAuthorization(homeDir));
	if (init.body !== undefined) headers.set('content-type', 'application/json');
	const response = await (options.fetch ?? fetch)(`${assistantEndpoint(homeDir)}${path}`, {
		...init,
		headers,
		signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
	});
	const body = await responseJson(response);
	if (!response.ok) throw new Error(errorMessage(body, response.status));
	return body;
}

function authenticatedProviderIds(homeDir: string): Set<string> {
	const path = join(homeDir, 'knowledge', 'secrets', 'auth.json');
	if (!existsSync(path)) return new Set();
	try {
		const value = asRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown);
		return new Set(Object.keys(value ?? {}));
	} catch {
		return new Set();
	}
}

export async function listProviders(
	homeDir: string,
	options: { fetch?: FetchLike } = {}
): Promise<ProviderSummary[]> {
	const [providerValue, authValue] = await Promise.all([
		request(homeDir, '/provider', {}, options),
		request(homeDir, '/provider/auth', {}, options)
	]);
	const providerRoot = asRecord(providerValue);
	const methodsRoot = asRecord(authValue) ?? {};
	const connected = new Set(
		Array.isArray(providerRoot?.connected)
			? providerRoot.connected.filter((item): item is string => typeof item === 'string')
			: []
	);
	const authenticated = authenticatedProviderIds(homeDir);
	const providers = Array.isArray(providerRoot?.all) ? providerRoot.all : [];
	const summaries: ProviderSummary[] = [];
	for (const item of providers) {
		const provider = asRecord(item);
		if (!provider || typeof provider.id !== 'string') continue;
		const rawMethodsValue = methodsRoot[provider.id];
		const rawMethods: unknown[] = Array.isArray(rawMethodsValue) ? rawMethodsValue : [];
		const authMethods: ProviderSummary['authMethods'] = [];
		for (const rawMethod of rawMethods) {
			const method = asRecord(rawMethod);
			if (
				(method?.type === 'oauth' || method?.type === 'api') &&
				typeof method.label === 'string'
			) {
				authMethods.push({ type: method.type, label: method.label });
			}
		}
		summaries.push({
			id: provider.id,
			name: typeof provider.name === 'string' ? provider.name : provider.id,
			source: typeof provider.source === 'string' ? provider.source : 'unknown',
			modelCount: Object.keys(asRecord(provider.models) ?? {}).length,
			connected: connected.has(provider.id),
			authenticated: authenticated.has(provider.id),
			authMethods
		});
	}
	return summaries.sort((left, right) => left.name.localeCompare(right.name));
}

export async function setProviderApiKey(
	homeDir: string,
	providerId: string,
	key: string,
	options: { fetch?: FetchLike } = {}
): Promise<void> {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(providerId)) throw new Error('Invalid provider id');
	if (!key || /[\r\n]/.test(key)) throw new Error('Provider key must be one non-empty line');
	await request(
		homeDir,
		`/auth/${encodeURIComponent(providerId)}`,
		{ method: 'PUT', body: JSON.stringify({ type: 'api', key }) },
		options
	);
}

export async function removeProviderAuth(
	homeDir: string,
	providerId: string,
	options: { fetch?: FetchLike } = {}
): Promise<void> {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(providerId)) throw new Error('Invalid provider id');
	await request(
		homeDir,
		`/auth/${encodeURIComponent(providerId)}`,
		{ method: 'DELETE' },
		options
	);
}

export async function waitForAssistant(
	homeDir: string,
	options: { fetch?: FetchLike; timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
	const deadline = Date.now() + (options.timeoutMs ?? 60_000);
	let lastError = 'Assistant is not reachable';
	do {
		try {
			await request(homeDir, '/config', {}, { fetch: options.fetch, timeoutMs: 2_000 });
			return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
	} while (Date.now() < deadline);
	throw new Error(`Assistant did not become ready: ${lastError}`);
}

function readinessText(value: unknown): { text: string; provider?: string; model?: string } {
	const root = asRecord(value);
	const parts = Array.isArray(root?.parts) ? root.parts : [];
	const text = parts
		.map((part) => asRecord(part))
		.filter((part): part is Record<string, unknown> => part?.type === 'text')
		.map((part) => (typeof part.text === 'string' ? part.text : ''))
		.join('\n')
		.trim();
	const info = asRecord(root?.info);
	const model = asRecord(info?.model);
	const providerId =
		typeof info?.providerID === 'string'
			? info.providerID
			: typeof model?.providerID === 'string'
				? model.providerID
				: undefined;
	const modelId =
		typeof info?.modelID === 'string'
			? info.modelID
			: typeof model?.modelID === 'string'
				? model.modelID
				: undefined;
	return {
		text,
		...(providerId ? { provider: providerId } : {}),
		...(modelId ? { model: modelId } : {})
	};
}

export async function testAssistantReadiness(
	homeDir: string,
	options: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<AssistantReadiness> {
	let sessionId: string | undefined;
	try {
		await waitForAssistant(homeDir, { fetch: options.fetch, timeoutMs: 10_000, intervalMs: 100 });
		const created = asRecord(
			await request(
				homeDir,
				'/session',
				{
					method: 'POST',
					body: JSON.stringify({
						title: 'OpenPalm readiness check',
						agent: 'remote',
						metadata: { openpalm: { purpose: 'readiness' } }
					})
				},
				{ fetch: options.fetch, timeoutMs: 10_000 }
			)
		);
		if (!created || typeof created.id !== 'string') throw new Error('Could not create readiness session');
		sessionId = created.id;
		const response = await request(
			homeDir,
			`/session/${encodeURIComponent(sessionId)}/message`,
			{
				method: 'POST',
				body: JSON.stringify({
					agent: 'remote',
					system: `This is a readiness check. Do not use tools. Reply with exactly ${READY_TOKEN}.`,
					parts: [{ type: 'text', text: `Reply with exactly ${READY_TOKEN}.` }]
				})
			},
			{ fetch: options.fetch, timeoutMs: options.timeoutMs ?? 120_000 }
		);
		const ready = readinessText(response);
		if (!ready.text.includes(READY_TOKEN)) {
			return { ok: false, error: 'The provider responded, but the readiness token was missing' };
		}
		return {
			ok: true,
			response: ready.text,
			...(ready.provider ? { provider: ready.provider } : {}),
			...(ready.model ? { model: ready.model } : {})
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (sessionId) {
			try {
				await request(
					homeDir,
					`/session/${encodeURIComponent(sessionId)}`,
					{ method: 'DELETE' },
					{ fetch: options.fetch, timeoutMs: 5_000 }
				);
			} catch {
				// A readiness result is more useful than a cleanup-only failure.
			}
		}
	}
}
