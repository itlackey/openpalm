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
 *
 * Body (optional JSON):
 *   { overwriteConflicts?: boolean }   — default false
 *
 * Auth: admin token required.
 */
import { readFileSync } from 'node:fs';
import type { RequestHandler } from './$types';
import {
	requireAdmin,
	jsonResponse,
	errorResponse,
	getRequestId,
	parseJsonBody,
} from '$lib/server/helpers.js';
import { importHostOpenCode, detectHostOpenCode } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { opencodeFetch } from '$lib/server/opencode/http.js';

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

	// Live push to OpenCode (best-effort — if OpenCode isn't up, the file copy is enough)
	const hostStatus = detectHostOpenCode();
	let livePush: { pushed: number; failed: string[] } = { pushed: 0, failed: [] };
	if (hostStatus.authPath) {
		livePush = await pushAuthToOpenCode(hostStatus.authPath);
	}

	return jsonResponse(
		200,
		{
			ok: true,
			imported: result.imported,
			conflicts: result.conflicts,
			livePushed: livePush.pushed,
			livePushFailed: livePush.failed,
		},
		requestId
	);
};
