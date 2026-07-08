/**
 * Root landing (plan ui-runtime-modes-plan.md §6.5, client branch): boot the
 * connection store, then redirect — no stored connections means there is
 * nothing to chat with yet, so land on /connections/new; otherwise /chat.
 * With ssr=false this load runs in the browser after the SPA shell mounts.
 */
import { redirect } from '@sveltejs/kit';
import { getClientBoot } from '$lib/boot.js';
import { resolveLanding } from '$lib/resolve-landing.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
  const { store } = await getClientBoot();
  redirect(302, resolveLanding(await store.list()));
};
