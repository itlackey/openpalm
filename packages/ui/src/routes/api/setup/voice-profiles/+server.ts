import { json } from '@sveltejs/kit';
import {
	annotateAddonProfileAvailability,
	getAddonProfiles,
	getAddonProfileSelection,
	isSetupComplete,
	resolveOpenPalmHome,
} from '@openpalm/lib';
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import { getRequestId, requireAdmin } from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
	if (isSetupComplete(resolveOpenPalmHome())) {
		const requestId = getRequestId(event);
		const authError = requireAdmin(event, requestId);
		if (authError) return authError;
	}

	const state = getState();
	const profiles = await annotateAddonProfileAvailability(getAddonProfiles(state.homeDir, 'voice'));
	const selectedProfile = getAddonProfileSelection(state.stackDir, 'voice');

	return json({ ok: true, profiles, selectedProfile });
};
