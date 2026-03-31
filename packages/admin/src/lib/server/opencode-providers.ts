/**
 * OpenCode provider API helpers for the admin.
 *
 * Fetches provider catalog, auth methods, config, and configured providers
 * from the OpenCode server and assembles them into ProviderView objects
 * the UI can render directly.
 */
import type {
	ProviderActionResult,
	ProviderAuthMethod,
	ProviderPageState,
	ProviderView,
} from '$lib/types/providers.js';

const OPENCODE_URL = process.env.OP_OPENCODE_URL ?? process.env.OP_ASSISTANT_URL ?? 'http://localhost:4096';

type JsonRecord = Record<string, unknown>;

type RawProviderCatalogEntry = {
	id: string;
	name: string;
	env?: string[];
	models?: Record<string, { name?: string }>;
};

type RawConfiguredProvider = {
	id: string;
	name?: string;
	source?: string;
	env?: string[];
	key?: unknown;
	options?: Record<string, unknown>;
	models?: Record<string, { name?: string }>;
};

type RawProviderCatalog = {
	all: RawProviderCatalogEntry[];
	default: Record<string, string>;
	connected: string[];
};

type RawConfiguredProviders = {
	providers: RawConfiguredProvider[];
	default: Record<string, string>;
};

type RawConfig = JsonRecord & {
	provider?: Record<string, JsonRecord>;
	model?: string;
	small_model?: string;
	enabled_providers?: string[];
	disabled_providers?: string[];
};

type RawAuthMethod = {
	type: 'oauth' | 'api';
	label: string;
	prompts?: Array<{
		key: string;
		message: string;
		placeholder?: string;
		options?: string[];
		when?: string;
	}>;
};

export async function opencodeFetch<T>(
	path: string,
	init?: RequestInit
): Promise<T> {
	const response = await fetch(`${OPENCODE_URL}${path}`, {
		headers: {
			'content-type': 'application/json',
			...(init?.headers ?? {})
		},
		...init
	});

	if (!response.ok) {
		throw new Error(`${init?.method ?? 'GET'} ${path} failed with ${response.status}`);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return (await response.json()) as T;
}

export async function loadProviderPage(): Promise<ProviderPageState> {
	try {
		const [catalog, auth, ocConfig, configured] = await Promise.all([
			opencodeFetch<RawProviderCatalog>('/provider'),
			opencodeFetch<Record<string, RawAuthMethod[]>>('/provider/auth'),
			opencodeFetch<RawConfig>('/config'),
			opencodeFetch<RawConfiguredProviders>('/config/providers')
		]);

		// Merge disk config (has custom providers) with OpenCode's in-memory config
		const diskConfig = await getCurrentConfig();
		const config: RawConfig = {
			...ocConfig,
			provider: { ...(ocConfig.provider ?? {}), ...(diskConfig.provider ?? {}) },
			disabled_providers: diskConfig.disabled_providers ?? ocConfig.disabled_providers,
			enabled_providers: diskConfig.enabled_providers ?? ocConfig.enabled_providers,
		};

		const views = buildProviderViews(catalog, auth, config, configured);

		return {
			available: true,
			providers: views,
			currentModel: config.model,
			currentSmallModel: config.small_model,
			defaultModels: catalog.default,
			allowlistActive: Array.isArray(config.enabled_providers) && config.enabled_providers.length > 0,
			providerCountLabel: `${views.length} providers indexed from OpenCode`,
			stats: {
				total: views.length,
				connected: views.filter((p) => p.connected).length,
				configured: views.filter((p) => p.configured).length,
				disabled: views.filter((p) => p.disabled).length
			}
		};
	} catch (error) {
		return {
			available: false,
			error: error instanceof Error ? error.message : 'Unable to reach the OpenCode server.',
			providers: [],
			defaultModels: {},
			allowlistActive: false,
			providerCountLabel: 'The OpenCode server is currently unavailable.',
			stats: { total: 0, connected: 0, configured: 0, disabled: 0 }
		};
	}
}

export async function getCurrentConfig(): Promise<RawConfig> {
	// Read from disk — OpenCode's in-memory config may not reflect disk changes
	const { readFileSync } = await import('node:fs');
	const { join } = await import('node:path');
	const opHome = process.env.OP_HOME ?? '';
	const configPath = join(opHome, 'config', 'assistant', 'opencode.json');
	try {
		return JSON.parse(readFileSync(configPath, 'utf-8')) as RawConfig;
	} catch {
		// Fallback to OpenCode API if disk read fails
		return opencodeFetch<RawConfig>('/config');
	}
}

export async function patchConfig(config: RawConfig) {
	// Write directly to the host config file — OpenCode's PATCH /config
	// doesn't persist in Docker because the container config is read-only.
	const { readFileSync, writeFileSync } = await import('node:fs');
	const { join } = await import('node:path');
	const opHome = process.env.OP_HOME ?? '';
	const configPath = join(opHome, 'config', 'assistant', 'opencode.json');

	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(readFileSync(configPath, 'utf-8'));
	} catch {
		// file missing or invalid — start fresh
	}

	// Merge provider config into existing
	const merged = { ...existing, ...config };
	if (config.provider) {
		(merged as Record<string, unknown>).provider = { ...(existing.provider as Record<string, unknown> ?? {}), ...(config.provider as Record<string, unknown>) };
	}

	writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');

	// Also notify OpenCode to reload (best-effort)
	await opencodeFetch<RawConfig>('/config', {
		method: 'PATCH',
		body: JSON.stringify(config)
	}).catch(() => {});

	return merged as RawConfig;
}

export async function startOauthFlowAtBase(
	baseUrl: string,
	providerId: string,
	methodIndex: number,
	inputs?: Record<string, string>
) {
	const response = await fetch(`${baseUrl}/provider/${providerId}/oauth/authorize`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method: methodIndex, inputs })
	});

	if (!response.ok) {
		throw new Error(`POST /provider/${providerId}/oauth/authorize failed with ${response.status}`);
	}

	return (await response.json()) as { url: string; method: 'auto' | 'code'; instructions?: string };
}

export async function finishOauthFlowAtBase(
	baseUrl: string,
	providerId: string,
	methodIndex: number,
	code: string
) {
	const response = await fetch(`${baseUrl}/provider/${providerId}/oauth/callback`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method: methodIndex, code })
	});

	if (!response.ok) {
		throw new Error(`POST /provider/${providerId}/oauth/callback failed with ${response.status}`);
	}

	if (response.status === 204) return true;
	return (await response.json()) as boolean;
}

export function actionSuccess(message: string, selectedProviderId: string, extra: Partial<ProviderActionResult> = {}) {
	return {
		ok: true,
		message,
		selectedProviderId,
		...extra
	} satisfies ProviderActionResult;
}

export function actionFailure(message: string, selectedProviderId?: string, extra: Partial<ProviderActionResult> = {}) {
	return {
		ok: false,
		message,
		selectedProviderId,
		...extra
	} satisfies ProviderActionResult;
}

export function normalizeProviderConfig(providerConfig: JsonRecord | undefined) {
	const normalized = providerConfig ? { ...providerConfig } : {};
	const options = asRecord(normalized.options);

	if (options && Object.keys(options).length === 0) {
		delete normalized.options;
	}

	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function setProviderEnabled(config: RawConfig, providerId: string, enabled: boolean) {
	const disabled = new Set(config.disabled_providers ?? []);
	const allowlist = config.enabled_providers ? new Set(config.enabled_providers) : undefined;

	if (enabled) {
		disabled.delete(providerId);
		allowlist?.add(providerId);
	} else {
		disabled.add(providerId);
		allowlist?.delete(providerId);
	}

	config.disabled_providers = Array.from(disabled).sort();

	if (allowlist) {
		config.enabled_providers = Array.from(allowlist).sort();
	}

	return config;
}

// ── Internal helpers ──────────────────────────────────────────────────

function buildProviderViews(
	catalog: RawProviderCatalog,
	auth: Record<string, RawAuthMethod[]>,
	config: RawConfig,
	configured: RawConfiguredProviders
): ProviderView[] {
	const catalogMap = new Map(catalog.all.map((p) => [p.id, p]));
	const connected = new Set(catalog.connected);
	const disabled = new Set(config.disabled_providers ?? []);
	const allowlist = config.enabled_providers ? new Set(config.enabled_providers) : undefined;
	const configuredMap = new Map(configured.providers.map((p) => [p.id, p]));
	const providerIds = new Set([
		...catalog.all.map((p) => p.id),
		...Object.keys(config.provider ?? {}),
		...configured.providers.map((p) => p.id)
	]);

	return Array.from(providerIds)
		.map((providerId) => {
			const entry = catalogMap.get(providerId);
			const configEntry = asRecord(config.provider?.[providerId]);
			const resolvedEntry = configuredMap.get(providerId);
			const resolvedOptions = asRecord(resolvedEntry?.options);
			const rawOptions = { ...resolvedOptions, ...asRecord(configEntry?.options) };
			const authMethods = (auth[providerId] ?? []).map<ProviderAuthMethod>((method, index) => ({
				index,
				type: method.type,
				label: method.label,
				prompts: method.prompts ?? []
			}));
			const modelEntries =
				asModelRecord(resolvedEntry?.models) ?? asModelRecord(configEntry?.models) ?? asModelRecord(entry?.models) ?? {};
			const models = Object.entries(modelEntries)
				.map(([id, model]) => ({ id, name: model.name ?? id }))
				.sort((left, right) => left.name.localeCompare(right.name));
			const currentModelId = splitModel(config.model, providerId);
			const currentSmallModelId = splitModel(config.small_model, providerId);
			const enabled = allowlist ? allowlist.has(providerId) && !disabled.has(providerId) : !disabled.has(providerId);

			return {
				id: providerId,
				name: resolvedEntry?.name ?? asString(configEntry?.name) ?? entry?.name ?? providerId,
				source: resolvedEntry?.source ?? (entry ? (configEntry ? 'config' : 'catalog') : 'custom'),
				env: resolvedEntry?.env ?? asStringArray(configEntry?.env) ?? entry?.env ?? [],
				connected: connected.has(providerId),
				configured: Boolean(resolvedEntry || configEntry),
				disabled: !enabled,
				activeMainModel: Boolean(currentModelId),
				activeSmallModel: Boolean(currentSmallModelId),
				recommendedModelId:
					currentModelId ?? configured.default[providerId] ?? catalog.default[providerId] ?? models[0]?.id ?? '',
				modelCount: models.length,
				models,
				authMethods,
				options: {
					apiKey: asString(rawOptions.apiKey),
					baseURL: asString(rawOptions.baseURL),
					headers: asStringRecord(rawOptions.headers),
					timeout: asNumber(rawOptions.timeout),
					chunkTimeout: asNumber(rawOptions.chunkTimeout),
					setCacheKey: rawOptions.setCacheKey === true
				},
				supportsOauth: authMethods.some((m) => m.type === 'oauth'),
				supportsApiAuth: authMethods.some((m) => m.type === 'api')
			};
		})
		.sort((left, right) => {
			if (left.connected !== right.connected) return left.connected ? -1 : 1;
			if (left.activeMainModel !== right.activeMainModel) return left.activeMainModel ? -1 : 1;
			if (left.configured !== right.configured) return left.configured ? -1 : 1;
			if (left.disabled !== right.disabled) return left.disabled ? 1 : -1;
			return left.name.localeCompare(right.name);
		});
}

function splitModel(model: string | undefined, providerId: string) {
	if (!model?.startsWith(`${providerId}/`)) return undefined;
	return model.slice(providerId.length + 1);
}

function asRecord(value: unknown) {
	return value && typeof value === 'object' && !Array.isArray(value) ? ({ ...value } as JsonRecord) : undefined;
}

function asModelRecord(value: unknown) {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, { name?: string }>)
		: undefined;
}

function asString(value: unknown) {
	return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown) {
	return Array.isArray(value) ? value.filter((e): e is string => typeof e === 'string') : undefined;
}

function asStringRecord(value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string');
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function asNumber(value: unknown) {
	return typeof value === 'number' ? value : undefined;
}
