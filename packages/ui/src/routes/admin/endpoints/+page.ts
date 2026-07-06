/**
 * /admin/endpoints → /connections redirect alias (plan
 * ui-runtime-modes-plan.md Phase 2 step 5, issue #486).
 *
 * Connection management moved to the capability-guarded /connections surface.
 * This alias is kept for the 0.13.0 release only — Phase 4 turns /admin/*
 * into 404s. Same convention as the routes/+page.ts → /splash redirect.
 * (The sibling +server.ts JSON API remains for out-of-process callers this
 * release; SvelteKit content-negotiates HTML navigations to this page.)
 */
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  redirect(302, '/connections');
};
