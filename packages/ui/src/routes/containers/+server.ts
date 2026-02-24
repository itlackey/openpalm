import { json, unauthorizedJson } from '$lib/server/json';
import { knownServices } from '$lib/server/init';
import { composeList, composePull } from '@openpalm/lib/admin/compose-runner';
import type { RequestHandler } from './$types';

type ContainerDetails = {
	name: string;
	status: string;
	image: string;
	updateAvailable: boolean;
};

function hasNewerImage(pullOutput: string): boolean {
	if (pullOutput.includes('Downloaded newer image')) return true;
	if (pullOutput.includes('Image is up to date')) return false;
	return false;
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();

	const services = Array.from(await knownServices()).sort();
	const psResult = await composeList();
	const runningByService = new Map<string, { status: string; image: string }>();

	if (psResult.ok) {
		try {
			const rows = JSON.parse(psResult.stdout) as Array<Record<string, unknown>>;
			for (const row of rows) {
				const service = String(row.Service ?? row.Name ?? '');
				if (!service) continue;
				runningByService.set(service, {
					status: String(row.State ?? row.Status ?? 'unknown'),
					image: String(row.Image ?? 'unknown')
				});
			}
		} catch {
			// Keep container details best-effort if compose output is not JSON.
		}
	}

	const details: ContainerDetails[] = [];
	for (const service of services) {
		const pullResult = await composePull(service);
		const pullOutput = `${pullResult.stdout}\n${pullResult.stderr}`;
		details.push({
			name: service,
			status: runningByService.get(service)?.status ?? 'not_running',
			image: runningByService.get(service)?.image ?? 'unknown',
			updateAvailable: pullResult.ok && hasNewerImage(pullOutput)
		});
	}

	return json(200, { services: details });
};
