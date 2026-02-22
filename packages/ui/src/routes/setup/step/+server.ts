import { json } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const setupManager = await getSetupManager();
	const body = (await request.json()) as { step: string };
	const validSteps = [
		'welcome',
		'accessScope',
		'serviceInstances',
		'healthCheck',
		'security',
		'channels'
	];
	if (!validSteps.includes(body.step)) return json(400, { error: 'invalid step' });
	const state = setupManager.completeStep(
		body.step as 'welcome' | 'accessScope' | 'serviceInstances' | 'healthCheck' | 'security' | 'channels'
	);
	return json(200, { ok: true, state });
};
