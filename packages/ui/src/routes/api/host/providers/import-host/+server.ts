/**
 * POST /api/host/providers/import-host
 *
 * Copies host OpenCode config + auth into OP_HOME, pushes each imported
 * credential to the running OpenCode server, and restarts consumers so
 * imported provider configuration is loaded.
 *
 * - opencode.json: stripped of plugin/mcp/permission keys, merged with
 *   existing OP_HOME config. Provider conflicts preserved by default.
 * - auth.json: byte-copied and chmodded 0o600. Never logged.
 * - Live push: best-effort PUT to OpenCode /auth/{id} per credential.
 *   If OpenCode is unreachable, the file copy still applies and OpenCode
 *   will pick up the credentials on next restart.
 * - Service restart: assistant is restarted after the import so opencode.json
 *   provider blocks are re-read (live push only updates the auth store, not
 *   config).
 *
 * Body (optional JSON):
 *   { overwriteConflicts?: boolean }   — default false
 *
 * Auth: admin session cookie required (there is no admin token).
 */
import { existsSync } from 'node:fs';
import type { RequestHandler } from './$types';
import {
	requireAdmin,
	requireCapability,
	jsonResponse,
	errorResponse,
	getRequestId,
	parseJsonBody,
} from '$lib/server/helpers.js';
import {
	importHostOpenCode,
	detectHostOpenCode,
	authJsonPath,
	restartProviderConsumers,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { pushImportedAuth } from '$lib/server/provider-import.js';
import { withSerialQueue } from '$lib/server/serial-queue.js';

export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:secrets', requestId);
	if (capabilityError) return capabilityError;
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	return withSerialQueue('admin:providers:import-host', async () => {
		const state = getState();

		let overwriteConflicts = false;
		const contentType = event.request.headers.get('content-type') ?? '';
		if (contentType.includes('application/json')) {
			const parsed = await parseJsonBody(event.request);
			if (!('error' in parsed)) {
				overwriteConflicts = parsed.data.overwriteConflicts === true;
			}
		}

		// File-level import (durable)
		let result: ReturnType<typeof importHostOpenCode>;
		try {
			result = importHostOpenCode(state, { overwriteConflicts });
		} catch (err) {
			return errorResponse(500, 'import_failed', err instanceof Error ? err.message : 'Import failed', {}, requestId);
		}

		// Live push the merged imported auth.json (best-effort — if OpenCode isn't
		// up, the file copy is enough). Do not push the host auth.json directly:
		// conflict-preserving imports may intentionally leave existing credentials
		// untouched in OP_HOME/knowledge/secrets/auth.json.
		const hostStatus = detectHostOpenCode();
		let livePush = { pushed: [] as string[], errors: [] as { provider: string; error: string }[] };
		const importedAuthPath = authJsonPath(state);
		if (existsSync(importedAuthPath)) {
			livePush = await pushImportedAuth(importedAuthPath);
		} else if (hostStatus.authPath) {
			livePush = await pushImportedAuth(hostStatus.authPath);
		}

		// Live push handles the OpenCode auth store at runtime, but opencode.json
		// provider blocks are only loaded at assistant process start.
		const restart = await restartProviderConsumers(state, result.changed);

		return jsonResponse(
			200,
			{
				ok: true,
				imported: result.imported,
				conflicts: result.conflicts,
				livePushed: livePush.pushed.length,
				livePushFailed: livePush.errors.map(({ provider }) => provider),
				restarted: restart.restarted,
				restartFailed: restart.failed,
			},
			requestId
		);
	});
};
