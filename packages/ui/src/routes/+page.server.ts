/**
 * Root route — always redirects to the resolved landing (plan
 * ui-runtime-modes-plan.md §6.5, Phase 3).
 *
 * Document navigations to `/` are already redirected by the launch-routing
 * guard in hooks.server.ts (pre-auth). This server load covers CLIENT-SIDE
 * navigations to `/` (SvelteKit data requests), which resolve the same
 * landing through the same $lib/server/landing.js helper.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { resolveRequestLanding } from '$lib/server/landing.js';

export const load: PageServerLoad = async (event) => {
  redirect(302, await resolveRequestLanding(event));
};
