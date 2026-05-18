/**
 * Provider catalog assembly.
 *
 * Pulls catalog/auth/config/configured-provider data from the OpenCode server
 * (and the on-disk config), merges them, and emits ProviderView records the
 * UI renders directly.
 */
import type {
	ProviderAuthMethod,
	ProviderPageState,
	ProviderView,
} from '$lib/types/providers.js';
import { asNumber, asRecord, asString, asStringArray, asStringRecord } from '../coercion.js';
import { getCurrentConfig, type RawConfig } from './config.js';
import { opencodeFetch } from './http.js';

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

type RawAuthMethod = {
	type: 'oauth' | 'api';
	label: string;
	prompts?: Array<{
		key: string;
		message: string;
		placeholder?: string;
		options?: Array<{ label: string; value: string; hint?: string }>;
		when?: string;
	}>;
};

export async function loadProviderPage(): Promise<ProviderPageState> {
	try {
		const [catalog, auth, ocConfig, configured] = await Promise.all([
			opencodeFetch<RawProviderCatalog>('/provider'),
			opencodeFetch<Record<string, RawAuthMethod[]>>('/provider/auth'),
			opencodeFetch<RawConfig>('/config'),
			opencodeFetch<RawConfiguredProviders>('/config/providers'),
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
			allowlistActive:
				Array.isArray(config.enabled_providers) && config.enabled_providers.length > 0,
			providerCountLabel: `${views.length} providers indexed from OpenCode`,
			stats: {
				total: views.length,
				connected: views.filter((p) => p.connected).length,
				configured: views.filter((p) => p.configured).length,
				disabled: views.filter((p) => p.disabled).length,
			},
		};
	} catch (error) {
		return {
			available: false,
			error: error instanceof Error ? error.message : 'Unable to reach the OpenCode server.',
			providers: [],
			defaultModels: {},
			allowlistActive: false,
			providerCountLabel: 'The OpenCode server is currently unavailable.',
			stats: { total: 0, connected: 0, configured: 0, disabled: 0 },
		};
	}
}

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
		...configured.providers.map((p) => p.id),
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
				prompts: method.prompts ?? [],
			}));
			const modelEntries =
				asModelRecord(resolvedEntry?.models) ??
				asModelRecord(configEntry?.models) ??
				asModelRecord(entry?.models) ??
				{};
			const models = Object.entries(modelEntries)
				.map(([id, model]) => ({ id, name: model.name ?? id }))
				.sort((left, right) => left.name.localeCompare(right.name));
			const currentModelId = splitModel(config.model, providerId);
			const currentSmallModelId = splitModel(config.small_model, providerId);
			const enabled = allowlist
				? allowlist.has(providerId) && !disabled.has(providerId)
				: !disabled.has(providerId);

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
					currentModelId ??
					configured.default[providerId] ??
					catalog.default[providerId] ??
					models[0]?.id ??
					'',
				modelCount: models.length,
				models,
				authMethods,
				options: {
					apiKey: asString(rawOptions.apiKey),
					baseURL: asString(rawOptions.baseURL),
					headers: asStringRecord(rawOptions.headers),
					timeout: asNumber(rawOptions.timeout),
					chunkTimeout: asNumber(rawOptions.chunkTimeout),
					setCacheKey: rawOptions.setCacheKey === true,
				},
				supportsOauth: authMethods.some((m) => m.type === 'oauth'),
				supportsApiAuth: authMethods.some((m) => m.type === 'api'),
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

function asModelRecord(value: unknown) {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, { name?: string }>)
		: undefined;
}
