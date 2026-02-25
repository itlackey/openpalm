import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getSetupManager, getStackManager } from '$lib/server/init';
import { isLocalRequest } from '$lib/server/auth';
import { readSecretsEnv } from '$lib/server/env-helpers';
import { applyStack } from '@openpalm/lib/admin/stack-apply-engine';
import { composeAction } from '@openpalm/lib/admin/compose-runner';
import { syncAutomations } from '@openpalm/lib/admin/automations';
import { updateRuntimeEnvContent } from '@openpalm/lib/admin/runtime-env';
import { generateToken } from '@openpalm/lib/tokens';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SECRETS_ENV_PATH } from '$lib/server/config';
import type { RequestHandler } from './$types';

const CoreStartupServices = ['caddy', 'assistant', 'gateway', 'openmemory', 'openmemory-ui', 'postgres', 'qdrant'] as const;

export const POST: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const stackManager = await getStackManager();
	const current = setupManager.getState();
	if (current.completed === true && !locals.authenticated) return unauthorizedJson();

	// SECURITY: During initial setup, restrict to local/private IPs only.
	if (!current.completed && !isLocalRequest(request)) {
		return json(403, { error: 'setup endpoints are restricted to local network access' });
	}

	try {
		// Auto-generate POSTGRES_PASSWORD if not already set (required for compose interpolation).
		// Write synchronously so it is available when applyStack reads secrets.
		const existingSecrets = readSecretsEnv();
		if (!existingSecrets.POSTGRES_PASSWORD) {
			const current = existsSync(SECRETS_ENV_PATH) ? readFileSync(SECRETS_ENV_PATH, 'utf8') : '';
			const next = updateRuntimeEnvContent(current, { POSTGRES_PASSWORD: generateToken(32) });
			mkdirSync(dirname(SECRETS_ENV_PATH), { recursive: true });
			writeFileSync(SECRETS_ENV_PATH, next, 'utf8');
		}
		const applyResult = await applyStack(stackManager);
		const startupResult = await composeAction('up', [...CoreStartupServices]);
		if (!startupResult.ok) throw new Error(`core_startup_failed:${startupResult.stderr}`);
		syncAutomations(stackManager.listAutomations());
		const state = setupManager.completeSetup();
		return json(200, { ok: true, state, apply: applyResult });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith('secret_validation_failed:')) {
			return errorJson(
				400,
				'secret_reference_validation_failed',
				message.replace('secret_validation_failed:', '').split(',')
			);
		}
		return errorJson(500, 'setup_complete_failed', message);
	}
};
