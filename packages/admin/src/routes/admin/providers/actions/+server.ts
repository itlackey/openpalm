import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, errorResponse, getRequestId, parseJsonBody, jsonBodyError } from '$lib/server/helpers.js';
import {
	getCurrentConfig,
	patchConfig,
	normalizeProviderConfig,
	setProviderEnabled,
	startOauthFlowAtBase,
	finishOauthFlowAtBase,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode-providers.js';
import { ensureAuthServer } from '$lib/server/opencode-auth-subprocess.js';
import type { ProviderActionResult } from '$lib/types/providers.js';

export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const parsed = await parseJsonBody(event.request);
	if ('error' in parsed) return jsonBodyError(parsed, requestId);

	const body = parsed.data;
	const action = typeof body.action === 'string' ? body.action : '';

	try {
		let result: ProviderActionResult;

		switch (action) {
			case 'saveProvider':
				result = await handleSaveProvider(body);
				break;
			case 'toggleProvider':
				result = await handleToggleProvider(body);
				break;
			case 'setModel':
				result = await handleSetModel(body);
				break;
			case 'startOauth':
				result = await handleStartOauth(body);
				break;
			case 'finishOauth':
				result = await handleFinishOauth(body);
				break;
			case 'saveCustomProvider':
				result = await handleSaveCustomProvider(body);
				break;
			default:
				return errorResponse(400, 'invalid_action', `Unknown action: ${action}`, {}, requestId);
		}

		return jsonResponse(200, result, requestId);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
};

// ── Action Handlers ──────────────────────────────────────────────────

async function handleSaveProvider(body: Record<string, unknown>): Promise<ProviderActionResult> {
	const providerId = str(body.providerId);
	if (!providerId) return actionFailure('Pick a provider before saving changes.');

	const config = await getCurrentConfig();
	const providerConfig = { ...(config.provider ?? {}) };
	const currentEntry = asRecord(providerConfig[providerId]);
	const currentOptions = asRecord(currentEntry?.options) ?? {};
	const nextOptions = { ...currentOptions };

	updateStringOption(nextOptions, 'apiKey', str(body.apiKey));
	updateStringOption(nextOptions, 'baseURL', str(body.baseURL));
	updateNumberOption(nextOptions, 'timeout', str(body.timeout));
	updateNumberOption(nextOptions, 'chunkTimeout', str(body.chunkTimeout));
	updateBooleanOption(nextOptions, 'setCacheKey', body.setCacheKey === 'on' || body.setCacheKey === true);

	const nextEntry = normalizeProviderConfig({ ...currentEntry, options: nextOptions });
	if (nextEntry) providerConfig[providerId] = nextEntry;
	else delete providerConfig[providerId];

	config.provider = providerConfig;
	await patchConfig(config);

	return actionSuccess('Provider settings saved to your local OpenCode config.', providerId);
}

async function handleToggleProvider(body: Record<string, unknown>): Promise<ProviderActionResult> {
	const providerId = str(body.providerId);
	const nextState = str(body.enabled) === 'true';
	if (!providerId) return actionFailure('Pick a provider before changing its availability.');

	const config = await getCurrentConfig();
	await patchConfig(setProviderEnabled(config, providerId, nextState));

	return actionSuccess(
		nextState ? 'Provider enabled for model selection.' : 'Provider disabled for this workspace.',
		providerId
	);
}

async function handleSetModel(body: Record<string, unknown>): Promise<ProviderActionResult> {
	const providerId = str(body.providerId);
	const modelId = str(body.modelId);
	const target = str(body.target);

	if (!providerId || !modelId || (target !== 'model' && target !== 'small_model')) {
		return actionFailure('Choose a provider model before saving it.');
	}

	const config = await getCurrentConfig();
	config[target] = `${providerId}/${modelId}`;
	await patchConfig(config);

	return actionSuccess(
		target === 'model' ? 'Main model updated for this project.' : 'Small model updated for lightweight tasks.',
		providerId
	);
}

async function handleStartOauth(body: Record<string, unknown>): Promise<ProviderActionResult> {
	const providerId = str(body.providerId);
	const methodIndex = Number(str(body.methodIndex));

	if (!providerId || Number.isNaN(methodIndex)) {
		return actionFailure('Choose a provider sign-in method first.');
	}

	const inputs = extractInputs(body);
	const authBaseUrl = await ensureAuthServer();
	const oauth = await startOauthFlowAtBase(authBaseUrl, providerId, methodIndex, inputs);

	return actionSuccess('OAuth flow prepared. Open the link below to continue.', providerId, {
		oauth: {
			providerId,
			methodIndex,
			url: oauth.url,
			mode: oauth.method,
			instructions: oauth.instructions,
			inputs,
		}
	});
}

async function handleFinishOauth(body: Record<string, unknown>): Promise<ProviderActionResult> {
	const providerId = str(body.providerId);
	const methodIndex = Number(str(body.methodIndex));
	const code = str(body.code);

	if (!providerId || Number.isNaN(methodIndex) || !code) {
		return actionFailure('Paste the authorization code before finishing sign-in.', providerId);
	}

	const authBaseUrl = await ensureAuthServer();
	await finishOauthFlowAtBase(authBaseUrl, providerId, methodIndex, code);

	return actionSuccess('OAuth connection completed.', providerId);
}

async function handleSaveCustomProvider(body: Record<string, unknown>): Promise<ProviderActionResult> {
	const providerId = str(body.providerId);
	const displayName = str(body.displayName);
	const baseURL = str(body.baseURL);
	const apiKey = str(body.apiKey);
	const confirmOverwrite = str(body.confirmOverwrite) === 'true';

	if (!providerId || !/^[a-z0-9_-]+$/.test(providerId)) {
		return actionFailure('Use a lowercase provider id with letters, numbers, hyphens, or underscores.');
	}

	if (!displayName || !baseURL) {
		return actionFailure('Display name and base URL are required for a custom provider.', providerId);
	}

	const models = parseModels(str(body.modelsJson));
	const headers = parseHeaders(str(body.headersJson));
	const config = await getCurrentConfig();
	const providerConfig = { ...(config.provider ?? {}) };

	if (providerConfig[providerId] && !confirmOverwrite) {
		return actionFailure('A provider with this ID already exists. Enable overwrite to replace it.', providerId);
	}

	const entry: Record<string, unknown> = {
		npm: '@ai-sdk/openai-compatible',
		name: displayName,
		options: {
			baseURL,
			...(apiKey ? { apiKey } : {}),
			...(Object.keys(headers).length > 0 ? { headers } : {})
		},
	};
	if (models.length > 0) {
		entry.models = Object.fromEntries(models.map((m) => [m.id, buildModelConfig(m)]));
	}
	providerConfig[providerId] = entry;

	config.provider = providerConfig;
	await patchConfig(config);

	return actionSuccess('Custom provider saved to your OpenCode config.', providerId);
}

// ── Helpers ──────────────────────────────────────────────────────────

function str(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function updateStringOption(target: Record<string, unknown>, key: string, value: string) {
	if (value) target[key] = value;
	else delete target[key];
}

function updateNumberOption(target: Record<string, unknown>, key: string, value: string) {
	if (!value) { delete target[key]; return; }
	const parsed = Number(value);
	if (!Number.isNaN(parsed)) target[key] = parsed;
	else delete target[key];
}

function updateBooleanOption(target: Record<string, unknown>, key: string, value: boolean) {
	if (value) target[key] = true;
	else delete target[key];
}

function asRecord(value: unknown) {
	return value && typeof value === 'object' && !Array.isArray(value)
		? ({ ...value } as Record<string, unknown>)
		: undefined;
}

function extractInputs(body: Record<string, unknown>) {
	const inputs: Record<string, string> = {};
	for (const [key, value] of Object.entries(body)) {
		if (!key.startsWith('inputs[') || !key.endsWith(']') || typeof value !== 'string') continue;
		const inputKey = key.slice(7, -1).trim();
		if (!inputKey || value.trim().length === 0) continue;
		inputs[inputKey] = value.trim();
	}
	return inputs;
}

function parseModels(modelsJson: string) {
	if (!modelsJson) return [];
	const parsed = JSON.parse(modelsJson) as Array<{
		id?: string;
		name?: string;
		contextLimit?: unknown;
		outputLimit?: unknown;
	}>;
	return parsed
		.filter((m) => typeof m.id === 'string' && m.id.trim().length > 0)
		.map((m) => ({
			id: m.id!.trim(),
			name: typeof m.name === 'string' ? m.name.trim() : '',
			contextLimit: parseLimit(m.contextLimit),
			outputLimit: parseLimit(m.outputLimit)
		}));
}

function buildModelConfig(model: { id: string; name: string; contextLimit?: number; outputLimit?: number }) {
	const limit = {
		...(model.contextLimit ? { context: model.contextLimit } : {}),
		...(model.outputLimit ? { output: model.outputLimit } : {})
	};
	return {
		...(model.name ? { name: model.name } : {}),
		...(Object.keys(limit).length > 0 ? { limit } : {})
	};
}

function parseLimit(value: unknown) {
	if (typeof value !== 'number' && typeof value !== 'string') return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseHeaders(headersJson: string) {
	if (!headersJson) return {};
	const parsed = JSON.parse(headersJson) as Array<{ key?: string; value?: string }>;
	return Object.fromEntries(
		parsed
			.filter((h) => typeof h.key === 'string' && typeof h.value === 'string')
			.map((h) => [h.key!.trim(), h.value!.trim()])
			.filter((e) => e[0].length > 0 && e[1].length > 0)
	);
}
