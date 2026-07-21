/**
 * /connections/new — the "no connections yet" landing. resolveLanding() sends sessions
 * without a usable connection here; the connection manager lives at
 * /connections, so this route opens it with the add form expanded.
 */
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  redirect(302, '/connections?new=1');
};
