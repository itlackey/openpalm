/**
 * POST /admin/providers/import-host
 *
 * Copies host OpenCode config + auth into OP_HOME, then pushes each
 * imported credential to the running OpenCode server so the providers
 * appear connected immediately (no restart required).
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
 * Auth: admin token required.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { RequestHandler } from './$types';
import {
	requireAdmin,
	jsonResponse,
	errorResponse,
	getRequestId,
	parseJsonBody,
} from '$lib/server/helpers.js';
import {
	importHostOpenCode,
	detectHostOpenCode,
	buildComposeOptions,
	checkDocker,
} from '@openpalm/lib';
import { composeRestart } from '$lib/server/docker.js';
import { getState } from '$lib/server/state.js';
import { opencodeFetch } from '$lib/server/opencode/http.js';
import { withSerialQueue } from '$lib/server/serial-queue.js';

/**
 * Restart services that hold provider state in startup config.
 * Best-effort: the file-level import is the durable part; this is the polish
 * that makes the change visible without the user having to bounce things by hand.
 * OpenCode caches opencode.json provider blocks at startup, so imported
 * provider config needs a fresh assistant process.
 */
async function restartProviderConsumers(): Promise<{
	restarted: string[];
	failed: { service: string; error: string }[];
}> {
	const services = ['assistant'];
	const docker = await checkDocker();
	if (!docker.ok) {
		return { restarted: [], failed: services.map((s) => ({ service: s, error: 'docker unavailable' })) };
	}
	const state = getState();
	const opts = buildComposeOptions(state);
	const restarted: string[] = [];
	const failed: { service: string; error: string }[] = [];
	for (const service of services) {
		try {
			const r = await composeRestart([service], opts);
			if (r.ok) restarted.push(service);
			else failed.push({ service, error: r.stderr || `exit ${r.code}` });
		} catch (err) {
			failed.push({ service, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { restarted, failed };
}

/** Push each auth.json entry to OpenCode's /auth/{id} so the running process sees them. */
async function pushAuthToOpenCode(authPath: string): Promise<{ pushed: number; failed: string[] }> {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(authPath, 'utf-8'));
	} catch {
		return { pushed: 0, failed: [] };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { pushed: 0, failed: [] };
	}

	let pushed = 0;
	const failed: string[] = [];
	for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
		try {
			await opencodeFetch(`/auth/${encodeURIComponent(providerId)}`, {
				method: 'PUT',
				body: JSON.stringify(value),
			});
			pushed++;
		} catch {
			failed.push(providerId);
		}
	}
	return { pushed, failed };
}

export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
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
		let result;
		try {
			result = importHostOpenCode(state, { overwriteConflicts });
		} catch (err) {
			return errorResponse(500, 'import_failed', err instanceof Error ? err.message : 'Import failed', {}, requestId);
		}

		// Live push the merged imported auth.json (best-effort — if OpenCode isn't
		// up, the file copy is enough). Do not push the host auth.json directly:
		// conflict-preserving imports may intentionally leave existing credentials
		// untouched in OP_HOME/config/auth.json.
		const hostStatus = detectHostOpenCode();
		let livePush: { pushed: number; failed: string[] } = { pushed: 0, failed: [] };
		const importedAuthPath = `${state.configDir}/auth.json`;
		if (existsSync(importedAuthPath)) {
			livePush = await pushAuthToOpenCode(importedAuthPath);
		} else if (hostStatus.authPath) {
			livePush = await pushAuthToOpenCode(hostStatus.authPath);
		}

		// Live push handles the OpenCode auth store at runtime, but opencode.json
		// provider blocks are only loaded at assistant process start.
		const restart = await restartProviderConsumers();

		return jsonResponse(
			200,
			{
				ok: true,
				imported: result.imported,
				conflicts: result.conflicts,
				livePushed: livePush.pushed,
				livePushFailed: livePush.failed,
				restarted: restart.restarted,
				restartFailed: restart.failed,
			},
			requestId
		);
	});
};
