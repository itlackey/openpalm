/**
 * /connections/new — the pwa-static "no connections yet" landing (plan
 * ui-runtime-modes-plan.md §6.5, Phase 3). resolveLanding() sends sessions
 * without a usable connection here; in the host app the connection manager
 * lives at /connections, so this route opens it with the add form expanded.
 * Same alias convention as routes/admin/endpoints/+page.ts.
 */
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  redirect(302, '/connections?new=1');
};
