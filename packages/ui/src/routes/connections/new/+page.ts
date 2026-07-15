/**
 * /connections/new — the "no connections yet" landing (plan
 * ui-runtime-modes-plan.md §6.5, Phase 3). resolveLanding() sends sessions
 * without a usable connection here; the connection manager lives at
 * /connections, so this route opens it with the add form expanded.
 */
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  redirect(302, '/connections?new=1');
};
