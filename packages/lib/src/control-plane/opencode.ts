import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readStackConfig } from './stack-config.js';
import { stateSecretFile, writeFileAtomic } from './foundation.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_GUARDIAN_CONFIG_BYTES = 64 * 1024;
const READY_TOKEN = 'OPENPALM_READY';
const FRESH_GUARDIAN_MODEL = '"model": "opencode/big-pickle"';

export type ProviderAuthPrompt =
	| {
			type: 'text';
			key: string;
			message: string;
			placeholder?: string;
			when?: { key: string; op: 'eq' | 'neq'; value: string };
	  }
	| {
			type: 'select';
			key: string;
			message: string;
			options: Array<{ label: string; value: string; hint?: string }>;
			when?: { key: string; op: 'eq' | 'neq'; value: string };
	  };

export type ProviderAuthMethod = {
	index: number;
	type: 'oauth' | 'api';
	label: string;
	prompts?: ProviderAuthPrompt[];
};

export type ProviderOAuthAuthorization = {
	url: string;
	method: 'auto' | 'code';
	instructions: string;
};

export type ProviderSummary = {
	id: string;
	name: string;
	source: string;
	modelCount: number;
	defaultModel?: string;
	connected: boolean;
	authenticated: boolean;
	authMethods: ProviderAuthMethod[];
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

function boundedString(value: unknown, maximum: number): string | undefined {
	return typeof value === 'string' && value.length <= maximum ? value : undefined;
}

function parseWhen(value: unknown): ProviderAuthPrompt['when'] | undefined {
	const when = asRecord(value);
	const key = boundedString(when?.key, 128);
	const condition = when?.op === 'eq' || when?.op === 'neq' ? when.op : undefined;
	const expected = boundedString(when?.value, 4_096);
	return key && condition && expected !== undefined
		? { key, op: condition, value: expected }
		: undefined;
}

function parsePrompt(value: unknown): ProviderAuthPrompt | undefined {
	const prompt = asRecord(value);
	const key = boundedString(prompt?.key, 128);
	const message = boundedString(prompt?.message, 500);
	if (!key || !message) return undefined;
	const when = parseWhen(prompt?.when);
	if (prompt?.type === 'text') {
		const placeholder = boundedString(prompt.placeholder, 500);
		return {
			type: 'text',
			key,
			message,
			...(placeholder !== undefined ? { placeholder } : {}),
			...(when ? { when } : {})
		};
	}
	if (prompt?.type !== 'select' || !Array.isArray(prompt.options)) return undefined;
	const options = prompt.options
		.slice(0, 100)
		.map((item) => {
			const option = asRecord(item);
			const label = boundedString(option?.label, 500);
			const optionValue = boundedString(option?.value, 4_096);
			const hint = boundedString(option?.hint, 500);
			return label && optionValue !== undefined
				? {
						label,
						value: optionValue,
						...(hint !== undefined ? { hint } : {})
					}
				: undefined;
		})
		.filter((item): item is NonNullable<typeof item> => item !== undefined);
	if (options.length === 0) return undefined;
	return { type: 'select', key, message, options, ...(when ? { when } : {}) };
}

function providerIdValue(value: string): string {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid provider id');
	return value;
}

function oauthMethodIndex(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > 1_024) {
		throw new Error('Invalid provider authentication method.');
	}
	return value;
}

function oauthInputs(
	value: Record<string, string> | undefined
): Record<string, string> | undefined {
	if (!value) return undefined;
	const entries = Object.entries(value);
	if (entries.length > 32) throw new Error('Too many provider sign-in fields.');
	const output: Record<string, string> = {};
	for (const [key, input] of entries) {
		if (!/^[A-Za-z0-9._-]{1,128}$/.test(key) || typeof input !== 'string' || input.length > 4_096) {
			throw new Error('Invalid provider sign-in field.');
		}
		output[key] = input;
	}
	return output;
}

function modelIdValue(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value || value.length > 512) return undefined;
	return Array.from(value).some((character) => character.charCodeAt(0) < 32) ? undefined : value;
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

async function responseJson(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
	const declared = Number(response.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error('OpenCode response exceeded the size limit');
	}
	const text = await response.text();
	if (Buffer.byteLength(text, 'utf8') > maxBytes) {
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
	options: { fetch?: FetchLike; timeoutMs?: number; maxResponseBytes?: number } = {}
): Promise<unknown> {
	const headers = new Headers(init.headers);
	headers.set('authorization', assistantAuthorization(homeDir));
	if (init.body !== undefined) headers.set('content-type', 'application/json');
	const response = await (options.fetch ?? fetch)(`${assistantEndpoint(homeDir)}${path}`, {
		...init,
		headers,
		signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
	});
	const body = await responseJson(response, options.maxResponseBytes);
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
		request(
			homeDir,
			'/provider',
			{},
			{ ...options, maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES }
		),
		request(homeDir, '/provider/auth', {}, options)
	]);
	const providerRoot = asRecord(providerValue);
	const defaultModels = asRecord(providerRoot?.default) ?? {};
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
		for (const [index, rawMethod] of rawMethods.entries()) {
			const method = asRecord(rawMethod);
			if (
				(method?.type === 'oauth' || method?.type === 'api') &&
				typeof method.label === 'string'
			) {
				const rawPrompts = Array.isArray(method.prompts) ? method.prompts : [];
				const prompts = rawPrompts
					.slice(0, 32)
					.map(parsePrompt)
					.filter((prompt): prompt is ProviderAuthPrompt => prompt !== undefined);
				authMethods.push({
					index,
					type: method.type,
					label: method.label.slice(0, 500),
					...(prompts.length > 0 ? { prompts } : {})
				});
			}
		}
		// Catalog providers without a plugin use OpenCode's standard /auth API-key flow.
		if (rawMethods.length === 0) {
			authMethods.push({ index: 0, type: 'api', label: 'API key' });
		}
		const defaultModel = modelIdValue(defaultModels[provider.id]);
		summaries.push({
			id: provider.id,
			name: typeof provider.name === 'string' ? provider.name : provider.id,
			source: typeof provider.source === 'string' ? provider.source : 'unknown',
			modelCount: Object.keys(asRecord(provider.models) ?? {}).length,
			...(defaultModel ? { defaultModel } : {}),
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
	providerId = providerIdValue(providerId);
	if (!key || /[\r\n]/.test(key)) throw new Error('Provider key must be one non-empty line');
	await request(
		homeDir,
		`/auth/${encodeURIComponent(providerId)}`,
		{ method: 'PUT', body: JSON.stringify({ type: 'api', key }) },
		options
	);
	await refreshAssistantInstance(homeDir, options);
}

export async function refreshAssistantInstance(
	homeDir: string,
	options: { fetch?: FetchLike } = {}
): Promise<void> {
	await request(homeDir, '/instance/dispose', { method: 'POST' }, options);
}

export async function beginProviderOAuth(
	homeDir: string,
	providerId: string,
	method: number,
	inputs?: Record<string, string>,
	options: { fetch?: FetchLike } = {}
): Promise<ProviderOAuthAuthorization> {
	const id = providerIdValue(providerId);
	const value = await request(
		homeDir,
		`/provider/${encodeURIComponent(id)}/oauth/authorize`,
		{
			method: 'POST',
			body: JSON.stringify({
				method: oauthMethodIndex(method),
				...(inputs ? { inputs: oauthInputs(inputs) } : {})
			})
		},
		options
	);
	const authorization = asRecord(value);
	const url = boundedString(authorization?.url, 4_096);
	const signInMethod =
		authorization?.method === 'auto' || authorization?.method === 'code'
			? authorization.method
			: undefined;
	const instructions = boundedString(authorization?.instructions, 10_000);
	if (!url || !signInMethod || instructions === undefined) {
		throw new Error('OpenCode returned an invalid provider sign-in response.');
	}
	return { url, method: signInMethod, instructions };
}

export async function completeProviderOAuth(
	homeDir: string,
	providerId: string,
	method: number,
	code?: string,
	options: { fetch?: FetchLike } = {}
): Promise<void> {
	const id = providerIdValue(providerId);
	if (code !== undefined && (!code.trim() || code.length > 10_000)) {
		throw new Error('Provider authorization code is invalid.');
	}
	const result = await request(
		homeDir,
		`/provider/${encodeURIComponent(id)}/oauth/callback`,
		{
			method: 'POST',
			body: JSON.stringify({
				method: oauthMethodIndex(method),
				...(code !== undefined ? { code: code.trim() } : {})
			})
		},
		options
	);
	if (result !== true) throw new Error('OpenCode did not complete provider sign-in.');
	await refreshAssistantInstance(homeDir, options);
}

export async function removeProviderAuth(
	homeDir: string,
	providerId: string,
	options: { fetch?: FetchLike } = {}
): Promise<void> {
	const id = providerIdValue(providerId);
	await request(homeDir, `/auth/${encodeURIComponent(id)}`, { method: 'DELETE' }, options);
	await refreshAssistantInstance(homeDir, options);
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

function readinessError(value: unknown): string | undefined {
	const root = asRecord(value);
	const info = asRecord(root?.info);
	const failure = asRecord(info?.error) ?? asRecord(root?.error);
	if (!failure) return undefined;
	const data = asRecord(failure.data);
	const message =
		typeof failure.message === 'string' && failure.message
			? failure.message
			: typeof data?.message === 'string' && data.message
				? data.message
				: typeof failure.name === 'string' && failure.name
					? failure.name
					: undefined;
	return message?.slice(0, 500);
}

export async function testAssistantReadiness(
	homeDir: string,
	options: { fetch?: FetchLike; timeoutMs?: number; provider?: string; model?: string } = {}
): Promise<AssistantReadiness> {
	let sessionId: string | undefined;
	try {
		await waitForAssistant(homeDir, { fetch: options.fetch, timeoutMs: 10_000, intervalMs: 100 });
		let selectedModel: { providerID: string; modelID: string } | undefined;
		if (options.provider) {
			const providerID = providerIdValue(options.provider);
			let modelID = modelIdValue(options.model);
			if (!modelID) {
				const providers = asRecord(
					await request(
						homeDir,
						'/provider',
						{},
						{
							fetch: options.fetch,
							timeoutMs: 10_000,
							maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES
						}
					)
				);
				modelID = modelIdValue(asRecord(providers?.default)?.[providerID]);
			}
			if (!modelID) {
				throw new Error(`OpenCode did not report a default model for ${providerID}`);
			}
			selectedModel = { providerID, modelID };
		} else if (options.model !== undefined) {
			throw new Error('A readiness model requires a provider.');
		}
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
		if (!created || typeof created.id !== 'string')
			throw new Error('Could not create readiness session');
		sessionId = created.id;
		const response = await request(
			homeDir,
			`/session/${encodeURIComponent(sessionId)}/message`,
			{
				method: 'POST',
				body: JSON.stringify({
					agent: 'remote',
					...(selectedModel ? { model: selectedModel } : {}),
					system: `This is a readiness check. Do not use tools. Reply with exactly ${READY_TOKEN}.`,
					parts: [{ type: 'text', text: `Reply with exactly ${READY_TOKEN}.` }]
				})
			},
			{ fetch: options.fetch, timeoutMs: options.timeoutMs ?? 120_000 }
		);
		const failure = readinessError(response);
		if (failure) return { ok: false, error: failure };
		const ready = readinessText(response);
		if (!ready.text.includes(READY_TOKEN)) {
			return { ok: false, error: 'The provider responded, but the readiness token was missing' };
		}
		const provider = ready.provider ?? selectedModel?.providerID;
		const model = ready.model ?? selectedModel?.modelID;
		return {
			ok: true,
			response: ready.text,
			...(provider ? { provider } : {}),
			...(model ? { model } : {})
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

export function configureGuardianModeratorModel(
	homeDir: string,
	provider: string | undefined,
	model: string | undefined
): boolean {
	if (!provider || !model) return false;
	if (
		provider.length > 128 ||
		model.length > 256 ||
		[provider, model].some((value) =>
			Array.from(value).some((character) => character.charCodeAt(0) < 32)
		)
	) {
		throw new Error('Provider readiness returned an invalid model identifier.');
	}
	const path = join(homeDir, 'config', 'guardian', 'opencode.json');
	if (!existsSync(path)) return false;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`Refusing unsafe Guardian configuration: ${path}`);
	}
	if (stat.size > MAX_GUARDIAN_CONFIG_BYTES) {
		throw new Error('Guardian configuration exceeded the size limit.');
	}
	const current = readFileSync(path, 'utf8');
	const occurrences = current.split(FRESH_GUARDIAN_MODEL).length - 1;
	if (occurrences === 0) return false;
	if (occurrences !== 1)
		throw new Error('Guardian configuration contains duplicate model settings.');
	const selected = `"model": ${JSON.stringify(`${provider}/${model}`)}`;
	writeFileAtomic(path, current.replace(FRESH_GUARDIAN_MODEL, selected), stat.mode & 0o777);
	return true;
}
