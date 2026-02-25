import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import {
	getSetupManager,
	getStackManager,
	allChannelServiceNames,
	knownServices,
	log
} from '$lib/server/init';
import { isLocalRequest } from '$lib/server/auth';
import {
	readRuntimeEnv,
	updateRuntimeEnv,
	updateSecretsEnv,
	readSecretsEnv,
	readDataEnv,
	updateDataEnv,
	setRuntimeBindScope,
	writeSecretsRaw,
	validateSecretsRawContent
} from '$lib/server/env-helpers';
import { applySmallModelToOpencodeConfig } from '$lib/server/opencode-config';
import {
	parseStackSpec,
	type StackChannelConfig,
	type StackServiceConfig,
	type StackAutomation
} from '@openpalm/lib/admin/stack-spec';
import { sanitizeEnvScalar, updateRuntimeEnvContent } from '@openpalm/lib/admin/runtime-env';
import { generateToken } from '@openpalm/lib/tokens';
import { applyStack } from '@openpalm/lib/admin/stack-apply-engine';
import {
	composeAction,
	composeList,
	composeLogs,
	composeLogsValidateTail,
	composePull,
	allowedServiceSet,
	composePs
} from '@openpalm/lib/admin/compose-runner';
import { syncAutomations, triggerAutomation } from '@openpalm/lib/admin/automations';
import { parse as yamlParse } from 'yaml';
import { randomUUID } from 'node:crypto';
import { SECRETS_ENV_PATH, RUNTIME_ENV_PATH, OPENMEMORY_URL as DEFAULT_OPENMEMORY_URL } from '$lib/server/config';
import { upsertEnvVar } from '@openpalm/lib/env';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RequestHandler } from './$types';

const SetupCoreServices = [
	'caddy',
	'assistant',
	'gateway',
	'openmemory',
	'openmemory-ui',
	'postgres',
	'qdrant'
] as const;

async function normalizeSelectedChannels(value: unknown): Promise<string[]> {
	if (!Array.isArray(value)) return [];
	const validServices = new Set(await allChannelServiceNames());
	const selected: string[] = [];
	for (const service of value) {
		if (typeof service !== 'string') continue;
		if (!validServices.has(service)) continue;
		if (selected.includes(service)) continue;
		selected.push(service);
	}
	return selected;
}

async function getConfiguredServiceInstances() {
	const runtime = readRuntimeEnv();
	const setupManager = await getSetupManager();
	const state = setupManager.getState();
	return {
		openmemory: runtime.OPENMEMORY_URL ?? state.serviceInstances.openmemory ?? '',
		psql: runtime.OPENMEMORY_POSTGRES_URL ?? state.serviceInstances.psql ?? '',
		qdrant: runtime.OPENMEMORY_QDRANT_URL ?? state.serviceInstances.qdrant ?? ''
	};
}

function getConfiguredOpenmemoryProvider() {
	const secrets = readSecretsEnv();
	return {
		openaiBaseUrl: secrets.OPENAI_BASE_URL ?? '',
		openaiApiKeyConfigured: Boolean(secrets.OPENAI_API_KEY)
	};
}

async function getConfiguredSmallModel() {
	const setupManager = await getSetupManager();
	const state = setupManager.getState();
	const secrets = readSecretsEnv();
	return {
		endpoint: state.smallModel.endpoint,
		modelId: state.smallModel.modelId,
		apiKeyConfigured: Boolean(secrets.OPENPALM_SMALL_MODEL_API_KEY)
	};
}

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = (await request.json()) as { type?: string; payload?: Record<string, unknown> };
	const payload = body.payload ?? {};
	const type = body.type ?? '';
	const setupManager = await getSetupManager();
	const setupState = setupManager.getState();
	const setupCommand = type.startsWith('setup.');
	const localSetupRequest = setupCommand && !setupState.completed && isLocalRequest(request);

	if (!locals.authenticated && !localSetupRequest) return unauthorizedJson();
	if (!locals.authenticated && setupCommand && !isLocalRequest(request)) {
		return json(403, { ok: false, error: 'setup endpoints are restricted to local network access' });
	}

	const stackManager = await getStackManager();
	try {
		if (type === 'stack.render')
			return json(200, { ok: true, data: stackManager.renderPreview() });
		if (type === 'stack.spec.set') {
			const spec = parseStackSpec(payload.spec);
			const missing = stackManager.validateReferencedSecrets(spec);
			if (missing.length > 0)
				return json(400, {
					ok: false,
					error: 'missing secret references',
					code: 'missing_secret_references',
					details: missing
				});
			try {
				return json(200, { ok: true, data: stackManager.setSpec(spec) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return json(400, { ok: false, error: message, code: message });
			}
		}
		if (type === 'stack.apply') {
			const result = await applyStack(stackManager, { apply: true });
			return json(200, { ok: true, data: result });
		}
		if (type === 'stack.catalog.item') {
			const action =
				payload.action === 'install' ||
				payload.action === 'uninstall' ||
				payload.action === 'configure' ||
				payload.action === 'add_instance'
					? payload.action
					: '';
			const itemType = payload.itemType === 'channel' || payload.itemType === 'service'
				? payload.itemType
				: '';
			const name = sanitizeEnvScalar(payload.name);
			if (!action || !itemType || !name) {
				return json(400, {
					ok: false,
					error: 'invalid_catalog_item_payload',
					code: 'invalid_catalog_item_payload'
				});
			}
			const item = stackManager.mutateStackCatalogItem({
				action,
				type: itemType,
				name,
				templateName: payload.templateName,
				supportsMultipleInstances: payload.supportsMultipleInstances,
				displayName: payload.displayName,
				description: payload.description,
				fields: payload.fields,
				image: payload.image,
				containerPort: payload.containerPort,
				rewritePath: payload.rewritePath,
				sharedSecretEnv: payload.sharedSecretEnv,
				volumes: payload.volumes,
				dependsOn: payload.dependsOn,
				exposure: payload.exposure,
				config: payload.config
			});
			return json(200, { ok: true, data: { item } });
		}
		if (type === 'setup.step') {
			const step = sanitizeEnvScalar(payload.step);
			const validSteps = [
				'welcome',
				'profile',
				'accessScope',
				'serviceInstances',
				'healthCheck',
				'security',
				'channels'
			];
			if (!validSteps.includes(step))
				return json(400, { ok: false, error: 'invalid_step', code: 'invalid_step' });
			const state = setupManager.completeStep(
				step as
					| 'welcome'
					| 'profile'
					| 'accessScope'
					| 'serviceInstances'
					| 'healthCheck'
					| 'security'
					| 'channels'
			);
			return json(200, { ok: true, data: state });
		}
			if (type === 'setup.start_core') {
				stackManager.renderArtifacts();
				(async () => {
				const services = [
					'postgres',
					'qdrant',
					'openmemory',
					'openmemory-ui',
					'assistant',
					'gateway'
				];
					await Promise.allSettled(services.map((svc) => composePull(svc)));
					for (const svc of services) {
						await composeAction('up', svc)
							.then((result) => {
								if (!result.ok) {
									log.error(`Start ${svc} failed`, { error: result.stderr || 'compose up failed' });
								}
							})
							.catch((e) => log.error(`Start ${svc} failed`, { error: String(e) }));
					}
					await composeAction('restart', 'caddy')
						.then((result) => {
							if (!result.ok) {
								log.error('Caddy reload failed', { error: result.stderr || 'compose restart failed' });
							}
						})
						.catch((e) => log.error('Caddy reload failed', { error: String(e) }));
				})().catch((e) => log.error('Core startup failed', { error: String(e) }));
				return json(200, { ok: true, status: 'starting' });
			}
		if (type === 'setup.access_scope') {
			const scope = payload.scope;
			if (scope !== 'host' && scope !== 'lan' && scope !== 'public')
				return json(400, { ok: false, error: 'invalid_scope', code: 'invalid_scope' });
			stackManager.setAccessScope(scope);
				await setRuntimeBindScope(scope);
			if (setupManager.getState().completed) {
				await Promise.all([
					composeAction('up', 'caddy'),
					composeAction('up', 'openmemory'),
					composeAction('up', 'assistant')
				]);
			} else {
				await composeAction('up', 'caddy').catch(() => {});
			}
			return json(200, { ok: true, data: setupManager.setAccessScope(scope) });
		}

		if (type === 'setup.profile') {
			const name = sanitizeEnvScalar(payload.name);
			const email = sanitizeEnvScalar(payload.email);
			const password = typeof payload.password === 'string' ? payload.password.trim() : '';
				await updateDataEnv({
					OPENPALM_PROFILE_NAME: name || undefined,
					OPENPALM_PROFILE_EMAIL: email || undefined
				});
			if (password.length >= 8) {
				await upsertEnvVar(RUNTIME_ENV_PATH, 'ADMIN_TOKEN', password);
			}
			const state = setupManager.setProfile({ name, email });
			stackManager.renderArtifacts();
			if (setupManager.getState().completed) await composeAction('up', 'assistant').catch(() => {});
			const dataEnv = readDataEnv();
			return json(200, {
				ok: true,
				data: {
					state,
					profile: {
						name: dataEnv.OPENPALM_PROFILE_NAME ?? state.profile.name,
						email: dataEnv.OPENPALM_PROFILE_EMAIL ?? state.profile.email
					}
				}
			});
		}

		if (type === 'setup.service_instances') {
			const openmemory = sanitizeEnvScalar(payload.openmemory);
			const psql = sanitizeEnvScalar(payload.psql);
			const qdrant = sanitizeEnvScalar(payload.qdrant);
			const openaiBaseUrl = sanitizeEnvScalar(payload.openaiBaseUrl);
			const openaiApiKey = sanitizeEnvScalar(payload.openaiApiKey);
			const anthropicApiKey = sanitizeEnvScalar(payload.anthropicApiKey);
			const smallModelEndpoint = sanitizeEnvScalar(payload.smallModelEndpoint);
			const smallModelApiKey = sanitizeEnvScalar(payload.smallModelApiKey);
			const smallModelId = sanitizeEnvScalar(payload.smallModelId);

			// During initial setup, require Anthropic key unless already configured
			if (!setupState.completed) {
				const existingSecrets = readSecretsEnv();
				if (!anthropicApiKey && !existingSecrets.ANTHROPIC_API_KEY) {
					return json(400, { ok: false, error: 'anthropic_key_required', code: 'anthropic_key_required' });
				}
			}

				await updateRuntimeEnv({
					OPENMEMORY_URL: openmemory || undefined,
					OPENMEMORY_POSTGRES_URL: psql || undefined,
					OPENMEMORY_QDRANT_URL: qdrant || undefined
				});
			const secretEntries: Record<string, string | undefined> = {
				OPENAI_BASE_URL: openaiBaseUrl || undefined
			};
			if (openaiApiKey.length > 0) secretEntries.OPENAI_API_KEY = openaiApiKey;
			if (anthropicApiKey.length > 0) secretEntries.ANTHROPIC_API_KEY = anthropicApiKey;
			if (smallModelApiKey.length > 0)
				secretEntries.OPENPALM_SMALL_MODEL_API_KEY = smallModelApiKey;
				await updateSecretsEnv(secretEntries);
			const state = setupManager.setServiceInstances({ openmemory, psql, qdrant });
			if (smallModelId) {
				setupManager.setSmallModel({ endpoint: smallModelEndpoint, modelId: smallModelId });
				applySmallModelToOpencodeConfig(smallModelEndpoint, smallModelId);
			}
			return json(200, {
				ok: true,
				data: {
					state,
					openmemoryProvider: getConfiguredOpenmemoryProvider(),
					smallModelProvider: await getConfiguredSmallModel()
				}
			});
		}
		if (type === 'setup.channels') {
			const channels = await normalizeSelectedChannels(payload.channels);
				await updateRuntimeEnv({
					OPENPALM_ENABLED_CHANNELS: channels.length ? channels.join(',') : undefined
				});
			const channelConfigs = payload.channelConfigs;
			if (channelConfigs && typeof channelConfigs === 'object') {
				const validServices = new Set(await allChannelServiceNames());
				for (const [service, values] of Object.entries(
					channelConfigs as Record<string, unknown>
				)) {
					if (
						!validServices.has(service) ||
						typeof values !== 'object' ||
						values === null
					)
						continue;
					const channelName = service.replace(/^channel-/, '');
					stackManager.setChannelConfig(channelName, values as Record<string, string>);
				}
			}
				const spec = stackManager.getSpec();
				for (const channelName of stackManager.listChannelNames()) {
					const service = `channel-${channelName}`;
					spec.channels[channelName].enabled = channels.includes(service);
				}
				stackManager.setSpec(spec);
				return json(200, { ok: true, data: setupManager.setEnabledChannels(channels) });
			}
		if (type === 'setup.complete') {
		// Auto-generate POSTGRES_PASSWORD if not already set (required for compose interpolation).
		// Write synchronously to secrets.env so it is available when applyStack reads secrets.
		const existingSecrets = readSecretsEnv();
		if (!existingSecrets.POSTGRES_PASSWORD) {
			const current = existsSync(SECRETS_ENV_PATH) ? readFileSync(SECRETS_ENV_PATH, 'utf8') : '';
			const next = updateRuntimeEnvContent(current, { POSTGRES_PASSWORD: generateToken(32) });
			mkdirSync(dirname(SECRETS_ENV_PATH), { recursive: true });
			writeFileSync(SECRETS_ENV_PATH, next, 'utf8');
		}
			const applyResult = await applyStack(stackManager);
			const startupResult = await composeAction('up', [...SetupCoreServices]);
			if (!startupResult.ok) throw new Error(`core_startup_failed:${startupResult.stderr}`);
			syncAutomations(stackManager.listAutomations());
			return json(200, { ok: true, data: setupManager.completeSetup(), apply: applyResult });
		}
		if (type === 'channel.configure') {
			const channel = sanitizeEnvScalar(payload.channel);
			const exposure = typeof payload.exposure === 'string' ? payload.exposure : '';
			if (!channel)
				return json(400, {
					ok: false,
					error: 'invalid_channel',
					code: 'invalid_channel'
				});
			if (exposure === 'host' || exposure === 'lan' || exposure === 'public')
				stackManager.setChannelAccess(channel, exposure);
			if (
				payload.config !== undefined &&
				typeof payload.config === 'object' &&
				payload.config !== null
			) {
				const config: Record<string, string> = {};
				for (const [k, v] of Object.entries(payload.config as Record<string, unknown>)) {
					if (typeof v === 'string') config[k] = v;
				}
				stackManager.setChannelConfig(channel, config);
			}
			return json(200, {
				ok: true,
				data: {
					channel,
					exposure: stackManager.getChannelAccess(channel),
					config: stackManager.getChannelConfig(channel)
				}
			});
		}
		if (type === 'secret.upsert') {
			const name = typeof payload.name === 'string' ? payload.name : '';
			const value = typeof payload.value === 'string' ? payload.value : '';
			if (!name)
				return json(400, {
					ok: false,
					error: 'name is required',
					code: 'invalid_payload'
				});
			return json(200, { ok: true, data: { name: stackManager.upsertSecret(name, value) } });
		}
		if (type === 'secret.delete') {
			const name = typeof payload.name === 'string' ? payload.name : '';
			if (!name)
				return json(400, {
					ok: false,
					error: 'name is required',
					code: 'invalid_payload'
				});
			return json(200, {
				ok: true,
				data: { name: stackManager.deleteSecret(name) }
			});
		}
		if (type === 'secret.set_admin_password') {
			const password = typeof payload.password === 'string' ? payload.password.trim() : '';
			if (password.length < 8) {
				return json(400, { ok: false, error: 'Password must be at least 8 characters.', code: 'invalid_password' });
			}
			await upsertEnvVar(RUNTIME_ENV_PATH, 'ADMIN_TOKEN', password);
			await composeAction('restart', 'admin');
			return json(200, { ok: true });
		}
		if (type === 'secret.raw.set') {
			const content = typeof payload.content === 'string' ? payload.content : '';
			const validationError = validateSecretsRawContent(content);
			if (validationError)
				return json(400, {
					ok: false,
					error: validationError,
					code: 'invalid_secrets_content'
				});
			writeSecretsRaw(content);
			stackManager.renderArtifacts();
			return json(200, { ok: true, data: { updated: true } });
		}
		if (type === 'automation.upsert') {
			const name = typeof payload.name === 'string' ? payload.name : '';
			const schedule = typeof payload.schedule === 'string' ? payload.schedule : '';
			const script = typeof payload.script === 'string' ? payload.script : '';
			if (!name || !schedule || !script)
				return json(400, {
					ok: false,
					error: 'name, schedule, and script are required',
					code: 'invalid_payload'
				});
			const id = typeof payload.id === 'string' ? payload.id : randomUUID();
			const enabled = typeof payload.enabled === 'boolean' ? payload.enabled : true;
			const automation = stackManager.upsertAutomation({
				id,
				name,
				schedule,
				enabled,
				script
			});
			syncAutomations(stackManager.listAutomations());
			return json(200, { ok: true, data: automation });
		}
		if (type === 'automation.delete') {
			const id = typeof payload.id === 'string' ? payload.id : '';
			if (!id)
				return json(400, { ok: false, error: 'id is required', code: 'invalid_payload' });
			try {
				const removed = stackManager.deleteAutomation(id);
				syncAutomations(stackManager.listAutomations());
				return json(200, { ok: true, data: { removed } });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === 'cannot_delete_core_automation')
					return json(400, { ok: false, error: message, code: message });
				throw error;
			}
		}
		if (type === 'snippet.import') {
			const yamlStr = typeof payload.yaml === 'string' ? payload.yaml : '';
			const section = typeof payload.section === 'string' ? payload.section : '';
			if (!yamlStr)
				return json(400, {
					ok: false,
					error: 'yaml is required',
					code: 'invalid_payload'
				});
			if (section !== 'channel' && section !== 'service' && section !== 'automation') {
				return json(400, {
					ok: false,
					error: "section must be 'channel', 'service', or 'automation'",
					code: 'invalid_payload'
				});
			}
			const parsed = yamlParse(yamlStr);
			const spec = stackManager.getSpec();
			if (section === 'channel') {
				if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
					return json(400, {
						ok: false,
						error: 'channel snippet must be a YAML object',
						code: 'invalid_snippet'
					});
				}
				for (const [name, value] of Object.entries(
					parsed as Record<string, unknown>
				)) {
					if (typeof value !== 'object' || value === null || !(value as Record<string, unknown>).image) {
						return json(400, {
							ok: false,
							error: `invalid_snippet: channel '${name}' must have an 'image' field`,
							code: 'invalid_snippet'
						});
					}
					spec.channels[name] = value as StackChannelConfig;
				}
			} else if (section === 'service') {
				if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
					return json(400, {
						ok: false,
						error: 'service snippet must be a YAML object',
						code: 'invalid_snippet'
					});
				}
				for (const [name, value] of Object.entries(
					parsed as Record<string, unknown>
				)) {
					if (typeof value !== 'object' || value === null || !(value as Record<string, unknown>).image) {
						return json(400, {
							ok: false,
							error: `invalid_snippet: service '${name}' must have an 'image' field`,
							code: 'invalid_snippet'
						});
					}
					spec.services[name] = value as StackServiceConfig;
				}
			} else {
				const items = Array.isArray(parsed) ? parsed : [parsed];
				const nextAutomations: StackAutomation[] = [];
				for (const item of items) {
					if (typeof item !== 'object' || item === null) {
						return json(400, {
							ok: false,
							error: "invalid_snippet: automation must be an object",
							code: 'invalid_snippet'
						});
					}
					const candidate = item as Record<string, unknown>;
					const id = typeof candidate.id === 'string' && candidate.id.trim()
						? candidate.id.trim()
						: randomUUID();
					const name = typeof candidate.name === 'string' && candidate.name.trim()
						? candidate.name.trim()
						: 'Imported automation';
					const schedule = typeof candidate.schedule === 'string' ? candidate.schedule.trim() : '';
					const script = typeof candidate.script === 'string'
						? candidate.script.trim()
						: typeof candidate.prompt === 'string'
							? candidate.prompt.trim()
							: '';
					const enabled = typeof candidate.enabled === 'boolean' ? candidate.enabled : true;
					if (!schedule || !script) {
						return json(400, {
							ok: false,
							error: "invalid_snippet: automation must have 'schedule' and 'script' (or 'prompt') fields",
							code: 'invalid_snippet'
						});
					}
					const automation: StackAutomation = { id, name, schedule, script, enabled };
					if (typeof candidate.description === 'string' && candidate.description.trim()) {
						automation.description = candidate.description.trim();
					}
					nextAutomations.push(automation);
				}
				spec.automations.push(...nextAutomations);
			}
			try {
				const validated = stackManager.setSpec(spec);
				return json(200, { ok: true, data: { spec: validated } });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return json(400, { ok: false, error: message, code: message });
			}
		}
		if (type === 'automation.trigger') {
			const id = sanitizeEnvScalar(payload.id);
			if (!id)
				return json(400, { ok: false, error: 'id_required', code: 'id_required' });
			if (!stackManager.getAutomation(id))
				return json(404, {
					ok: false,
					error: 'automation_not_found',
					code: 'automation_not_found'
				});
			const result = await triggerAutomation(id);
			return json(200, { ok: true, data: { id, ...result } });
		}
			if (type === 'service.restart') {
			const service = sanitizeEnvScalar(payload.service);
			if (!(await knownServices()).has(service))
				return json(400, {
					ok: false,
					error: 'service_not_allowed',
					code: 'service_not_allowed'
				});
				const result = await composeAction('restart', service);
				if (!result.ok) throw new Error(result.stderr || 'service_restart_failed');
				return json(200, { ok: true, data: { service } });
			}
		if (type === 'service.stop') {
			const service = sanitizeEnvScalar(payload.service);
			if (!(await knownServices()).has(service))
				return json(400, {
					ok: false,
					error: 'service_not_allowed',
					code: 'service_not_allowed'
				});
				const result = await composeAction('stop', service);
				if (!result.ok) throw new Error(result.stderr || 'service_stop_failed');
				return json(200, { ok: true, data: { service } });
			}
		if (type === 'service.up') {
			const service = sanitizeEnvScalar(payload.service);
			if (!(await knownServices()).has(service))
				return json(400, {
					ok: false,
					error: 'service_not_allowed',
					code: 'service_not_allowed'
				});
				const result = await composeAction('up', service);
				if (!result.ok) throw new Error(result.stderr || 'service_up_failed');
				return json(200, { ok: true, data: { service } });
			}
		if (type === 'service.update') {
			const service = sanitizeEnvScalar(payload.service);
			if (!(await knownServices()).has(service))
				return json(400, {
					ok: false,
					error: 'service_not_allowed',
					code: 'service_not_allowed'
				});
			const pullResult = await composePull(service);
			if (!pullResult.ok) throw new Error(pullResult.stderr || 'service_pull_failed');
				const result = await composeAction('up', service);
				if (!result.ok) throw new Error(result.stderr || 'service_up_failed');
				return json(200, { ok: true, data: { service } });
			}
		if (type === 'service.logs') {
			const service = sanitizeEnvScalar(payload.service);
			if (payload.tail !== undefined && typeof payload.tail !== 'number')
				return json(400, { ok: false, error: 'invalid_tail', code: 'invalid_tail' });
			const tail = typeof payload.tail === 'number' ? payload.tail : 200;
			if (!(await knownServices()).has(service))
				return json(400, {
					ok: false,
					error: 'service_not_allowed',
					code: 'service_not_allowed'
				});
			if (!composeLogsValidateTail(tail))
				return json(400, { ok: false, error: 'invalid_tail', code: 'invalid_tail' });
			const result = await composeLogs(service, tail);
			if (!result.ok) throw new Error(result.stderr || 'service_logs_failed');
			return json(200, { ok: true, data: { service, tail, logs: result.stdout } });
		}
		if (type === 'service.status') {
			const result = await composeList();
			if (!result.ok) throw new Error(result.stderr || 'service_status_failed');
			let services: unknown = result.stdout;
			try {
				services = JSON.parse(result.stdout);
			} catch {
				services = result.stdout;
			}
			return json(200, { ok: true, data: { services } });
		}
		if (type === 'service.drift') {
			const result = await composePs();
			if (!result.ok) return json(500, { ok: false, error: result.stderr });
			return json(200, { ok: true, data: { services: result.services } });
		}
		return json(400, { ok: false, error: 'unknown_command', code: 'unknown_command' });
	} catch (error) {
		return json(400, { ok: false, error: String(error), code: 'command_failed' });
	}
};
