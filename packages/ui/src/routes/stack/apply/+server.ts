import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { applyStack } from '@openpalm/lib/admin/stack-apply-engine';
import { composeAction, composeExec } from '@openpalm/lib/admin/compose-runner';
import { syncAutomations } from '@openpalm/lib/admin/automations';
import { existsSync, readFileSync } from 'node:fs';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	try {
		// Capture caddy state before apply to detect changes
		const caddyJsonPath = stackManager.getPaths().caddyJsonPath;
		const existingCaddyJson = existsSync(caddyJsonPath) ? readFileSync(caddyJsonPath, 'utf8') : '';

		const result = await applyStack(stackManager);

		// Start all services (Docker Compose handles change detection and orphan removal)
		const upResult = await composeAction('up', []);
		if (!upResult.ok) throw new Error(`compose_up_failed:${upResult.stderr}`);

		// Hot-reload caddy if its config changed
		if (existingCaddyJson !== result.generated.caddyJson) {
			await composeExec('caddy', ['caddy', 'reload', '--config', '/etc/caddy/caddy.json']).catch(() => {});
		}

		syncAutomations(stackManager.listAutomations());
		return json(200, result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith('secret_validation_failed:')) {
			return errorJson(
				400,
				'secret_reference_validation_failed',
				message.replace('secret_validation_failed:', '').split(',')
			);
		}
		return errorJson(500, 'stack_apply_failed', message);
	}
};
