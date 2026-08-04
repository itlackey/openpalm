/**
 * Whether this visitor has a session that can actually be signed out of.
 *
 * `event.locals.role` is set once per request in hooks.server.ts from
 * `identifyCallerByToken()`, which returns null whenever NO login password is
 * configured — so `role === 'admin'` means exactly "a login wall exists AND
 * this request holds a valid session". That is the only condition under which
 * a sign-out control does anything: in the client-only lane (no install, no
 * password) `POST /api/auth/login` answers 503, so offering sign-out there
 * logs the user out into a login page that cannot accept them back.
 *
 * Page-scoped rather than added to the root layout payload: that payload is
 * the RuntimeContext v2 contract, and this fact has exactly one consumer.
 */
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => ({
  signedIn: event.locals.role === 'admin',
});
