/**
 * /connections/new — the "no connections yet" landing (plan
 * ui-runtime-modes-plan.md §6.5). resolveLanding() sends sessions without a
 * stored connection here; the manager lives at /connections, so this route
 * opens it with the add form expanded (same alias convention as
 * packages/ui routes/connections/new).
 */
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  redirect(302, '/connections?new=1');
};
