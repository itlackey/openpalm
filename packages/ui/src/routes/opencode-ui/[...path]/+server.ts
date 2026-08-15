/**
 * SPA fallback for the static OpenCode web-UI bundle — standard single-page
 * hosting, nothing more.
 *
 * Real files under `/opencode-ui/*` (the shell, hashed assets, fonts) are
 * served by the static handler before SvelteKit runs, so this route only ever
 * sees the app's CLIENT-SIDE paths — session deep links like
 * `/opencode-ui/server/<key>/session/<id>` — and answers them with the shell.
 * The app's router (built with `base=/opencode-ui/`) resolves the rest.
 *
 * Deliberately unauthenticated, exactly like the static shell it mirrors: the
 * bundle is public UI code, and everything it can actually reach flows through
 * `/oc`, which enforces the session itself. hooks.server.ts exempts this
 * prefix from the landing/login redirects and marks it same-origin-framable
 * (`isOpencodeWebPath`).
 */
import type { RequestHandler } from './$types';
import { OPENCODE_WEB_PREFIX } from '$lib/opencode-web.js';

export const GET: RequestHandler = async (event) => {
  // SvelteKit's server-side fetch serves the app's own static assets without
  // a network hop, in dev and in the adapter-node build alike — the one
  // mechanism that resolves the shell identically in every lane.
  const shell = await event.fetch(`${OPENCODE_WEB_PREFIX}/index.html`);
  if (!shell.ok) {
    // The bundle is generated (gitignored), so a checkout that has not run the
    // build script serves an honest explanation instead of a blank frame.
    return new Response(
      'The OpenCode workspace bundle is not part of this build. Run scripts/opencode-web/build.sh and rebuild the UI.',
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }
  return new Response(shell.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The shell references hashed assets; the document itself must not be
      // cached across UI updates.
      'cache-control': 'no-cache',
    },
  });
};
