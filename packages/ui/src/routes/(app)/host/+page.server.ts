/**
 * Does this host actually have a stack to administer?
 *
 * Resolved in a page load, NOT in hooks.server.ts, because the answer is
 * needed for CLIENT-SIDE navigations to /host as well. The in-app admin button
 * is an ordinary SvelteKit link, so clicking it issues a data request that
 * never carries `Accept: text/html` — every document-navigation guard in hooks
 * is gated on `wantsHtml` and so never sees it. That is why the old
 * "/host → /setup when not installed" redirect appeared to work in a browser
 * reload and did nothing at all on the path users actually take. A `load` runs
 * on both lanes, so both get the same answer.
 *
 * Cheap: `getCachedLocalInstallState` is the same 5s-cached classification the
 * launch-routing guard already ran for this request. Uses
 * resolveOpenPalmHome()/stackDirFor() rather than getState(), which memoizes a
 * ControlPlaneState on first call and would disagree with the hooks guard when
 * a test swaps the home out from under it.
 */
import type { PageServerLoad } from './$types';
import { resolveOpenPalmHome, stackDirFor } from '@openpalm/lib';
import { getCachedLocalInstallState } from '$lib/server/landing.js';

export const load: PageServerLoad = () => {
  const homeDir = resolveOpenPalmHome();
  return {
    stackInstalled:
      getCachedLocalInstallState(stackDirFor(homeDir), homeDir) !== 'not_installed',
  };
};
