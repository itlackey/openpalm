/**
 * Provider catalog assembly.
 *
 * Pulls catalog/auth/config/configured-provider data from the OpenCode server
 * (and the on-disk config), merges them, and emits ProviderView records the
 * UI renders directly.
 */
import { readFileSync, existsSync } from 'node:fs';
import type {
	ProviderAuthMethod,
	ProviderPageState,
	ProviderView,
} from '$lib/types/providers.js';
import { asNumber, asRecord, asString, asStringArray, asStringRecord } from '../coercion.js';
import { getCurrentConfig, type RawConfig } from './config.js';
import { opencodeFetch } from './http.js';
import { resolveSetupOpencodeTarget } from './setup-target.js';
import { getState } from '../state.js';
import { authJsonPath } from '@openpalm/lib';

/**
 * Map of provider ID → credential type, as found in OpenCode's auth.json.
 * OpenCode's /provider response only reports env-var-detected providers in
 * `connected`; auth.json-stored credentials (API keys + OAuth tokens) are
 * loaded on-demand and don't appear there. We surface them here so the UI
 * can treat them as connected and show the right badge.
 */
function readAuthedProviders(): Map<string, 'api' | 'oauth'> {
	const out = new Map<string, 'api' | 'oauth'>();
	try {
		const path = authJsonPath(getState());
		if (!existsSync(path)) return out;
		const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { type?: string }>;
		for (const [id, entry] of Object.entries(data ?? {})) {
			const type = entry?.type === 'oauth' ? 'oauth' : 'api';
			out.set(id, type);
		}
	} catch {
		/* malformed file → empty */
	}
	return out;
}

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

		const authed = readAuthedProviders();
		const views = buildProviderViews(catalog, auth, config, configured, authed);

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

export type SetupProviderPageState =
  | { available: false; providers: []; }
  | {
      available: true;
      providers: RawProviderCatalogEntry[];
      auth: Record<string, RawAuthMethod[]>;
      connected: string[];
      selectedModels: { llm?: string; small?: string };
    };

export async function loadSetupProviderPage(): Promise<SetupProviderPageState> {
  // W1: on a fresh host the deployed assistant isn't up yet — resolve
  // whichever OpenCode the wizard should actually be talking to (the real
  // assistant if reachable, else the wizard-spawned instance `ensure`
  // started) instead of hardcoding the deployed-assistant target.
  const target = await resolveSetupOpencodeTarget();
  if (!target) return { available: false, providers: [] };
  try {
    const [catalog, auth] = await Promise.all([
      opencodeFetch<RawProviderCatalog>('/provider', undefined, target),
      opencodeFetch<Record<string, RawAuthMethod[]>>('/provider/auth', undefined, target),
    ]);
    return {
      available: true,
      providers: Array.isArray(catalog.all) ? catalog.all : [],
      auth,
      connected: Array.from(new Set([...(catalog.connected ?? []), ...readConnectedProviderIdsFromAuthJson()])),
      selectedModels: readSelectedModels(),
    };
  } catch {
    return { available: false, providers: [] };
  }
}

function readSelectedModels(): { llm?: string; small?: string } {
  try {
    const path = `${getState().configDir}/assistant/opencode.json`;
    if (!existsSync(path)) return {};
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return {
      ...(typeof data.model === 'string' && data.model ? { llm: data.model } : {}),
      ...(typeof data.small_model === 'string' && data.small_model ? { small: data.small_model } : {}),
    };
  } catch {
    return {};
  }
}

function readConnectedProviderIdsFromAuthJson(): string[] {
  try {
    const path = authJsonPath(getState());
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return Object.keys(data ?? {});
  } catch {
    return [];
  }
}

function extractAndSortModels(
	...sources: Array<unknown>
): Array<{ id: string; name: string }> {
	let entries: Record<string, { name?: string }> = {};
	for (const source of sources) {
		const record = asModelRecord(source);
		if (record) { entries = record; break; }
	}
	return Object.entries(entries)
		.map(([id, model]) => ({ id, name: model.name ?? id }))
		.sort((left, right) => left.name.localeCompare(right.name));
}

function buildProviderViews(
	catalog: RawProviderCatalog,
	auth: Record<string, RawAuthMethod[]>,
	config: RawConfig,
	configured: RawConfiguredProviders,
	authed: Map<string, 'api' | 'oauth'>
): ProviderView[] {
	const catalogMap = new Map(catalog.all.map((p) => [p.id, p]));
	const envConnected = new Set(catalog.connected);
	// "connected" = env-var detection (OpenCode's list) ∪ has-credential (auth.json)
	const connected = new Set([...envConnected, ...authed.keys()]);
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
			const models = extractAndSortModels(resolvedEntry?.models, configEntry?.models, entry?.models);
			const currentModelId = splitModel(config.model, providerId);
			const currentSmallModelId = splitModel(config.small_model, providerId);
			const enabled = allowlist
				? allowlist.has(providerId) && !disabled.has(providerId)
				: !disabled.has(providerId);

			const isConnected = connected.has(providerId);
			const isEnvConnected = envConnected.has(providerId);
			const authedType = authed.get(providerId);
			const credentialType: ProviderView['credentialType'] =
				!isConnected ? undefined
				: isEnvConnected ? 'env'
				: authedType ? authedType
				: configEntry ? 'config'
				: 'custom';

			return {
				id: providerId,
				name: resolvedEntry?.name ?? asString(configEntry?.name) ?? entry?.name ?? providerId,
				source: resolvedEntry?.source ?? (entry ? (configEntry ? 'config' : 'catalog') : 'custom'),
				env: resolvedEntry?.env ?? asStringArray(configEntry?.env) ?? entry?.env ?? [],
				connected: isConnected,
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
				credentialType,
				options: {
					// Credentials live in OpenCode's auth.json (managed via /auth/{providerID}),
					// not in opencode.json. Don't surface a stray apiKey here even if a legacy
					// config still has one — Connections never offers to edit it.
					baseURL: asString(rawOptions.baseURL),
					headers: asStringRecord(rawOptions.headers),
					timeout: asNumber(rawOptions.timeout),
					setCacheKey: rawOptions.setCacheKey === true,
					enterpriseUrl: asString(rawOptions.enterpriseUrl),
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
