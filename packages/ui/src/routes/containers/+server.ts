import { json, unauthorizedJson } from '$lib/server/json';
import { composeList } from '@openpalm/lib/admin/compose-runner';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();

	const psResult = await composeList();
	const services: Array<{ name: string; status: string; image: string }> = [];

	if (psResult.ok) {
		try {
			const rows = JSON.parse(psResult.stdout) as Array<Record<string, unknown>>;
			for (const row of rows) {
				const name = String(row.Service ?? row.Name ?? '');
				if (!name) continue;
				services.push({
					name,
					status: String(row.State ?? row.Status ?? 'unknown'),
					image: String(row.Image ?? 'unknown')
				});
			}
		} catch {
			// best-effort
		}
	}

	return json(200, { services });
};
