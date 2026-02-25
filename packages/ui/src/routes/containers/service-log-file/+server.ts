import { json, unauthorizedJson } from '$lib/server/json';
import { knownServices } from '$lib/server/init';
import { STATE_ROOT } from '$lib/server/config';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';

/**
 * Read persisted service log files written by the shared logger.
 *
 * POST body: { service: string, tail?: number }
 * Returns the last N lines from ${STATE_ROOT}/<service>/logs/service.log
 * (or ${STATE_ROOT}/<service>/service.log for gateway which writes to /app/data).
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const body = (await request.json()) as { service?: string; tail?: number };
	const service = body.service ?? '';
	const tail = typeof body.tail === 'number' ? Math.min(Math.max(body.tail, 1), 5000) : 200;

	if (!service || !(await knownServices()).has(service))
		return json(400, { error: 'unknown service name' });

	// Gateway writes logs to its /app/data mount (STATE_ROOT/gateway/)
	// All other services write to STATE_ROOT/<service>/logs/
	const logPaths = [
		join(STATE_ROOT, service, 'logs', 'service.log'),
		join(STATE_ROOT, service, 'service.log')
	];

	const logPath = logPaths.find((p) => existsSync(p));
	if (!logPath) {
		return json(200, { ok: true, service, tail, logs: '', lines: 0 });
	}

	try {
		const content = readFileSync(logPath, 'utf8');
		const allLines = content.split('\n').filter((l) => l.trim().length > 0);
		const sliced = allLines.slice(-tail);
		const stats = statSync(logPath);
		return json(200, {
			ok: true,
			service,
			tail,
			logs: sliced.join('\n'),
			lines: sliced.length,
			totalLines: allLines.length,
			fileSize: stats.size
		});
	} catch {
		return json(500, { error: 'failed to read log file' });
	}
};
