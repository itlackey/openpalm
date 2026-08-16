/**
 * The workspace ticket — how the OpenPalm session reaches a workspace that
 * lives on a different HOSTNAME.
 *
 * ## The problem it solves
 *
 * The workspace listener authenticates with the `op_session` cookie the browser
 * already holds (server/workspace-listener.ts). Cookies ignore PORT, so that
 * works for free whenever the workspace is another port on the same hostname —
 * a desktop install, a LAN install, Tailscale Serve.
 *
 * It stops working the moment a reverse proxy puts the workspace on a NAME of
 * its own, which is the idiomatic Caddy deployment: `openpalm.example.com` for
 * the UI, `code.example.com` for the workspace, both on 443, no extra port to
 * open. Cookies ARE scoped by host, so nothing the browser holds for the UI is
 * sent to the workspace, and the operator sees a 401 in the frame.
 *
 * ## Why a ticket rather than a wider cookie
 *
 * The obvious alternative — issue the session cookie with `Domain=example.com`
 * — hands the operator's session to EVERY subdomain of that domain, including
 * ones OpenPalm knows nothing about. A ticket gives exactly one host exactly
 * one cookie of its own, and nothing else changes.
 *
 * ## What a ticket is
 *
 * The same signed session token, minted with a one-minute life because it
 * travels in a URL instead of a cookie. It is verified by the same
 * `validateSession` as everything else — there is no second way to
 * authenticate, no second secret, and no new token format to get wrong. It is
 * spent on first use: the listener redeems it, sets a normal host-scoped
 * session cookie, and redirects to the same path with the parameter gone, so
 * the ticket never survives in the address bar or in a proxy log's replayable
 * window.
 *
 * ## The one thing this cannot fix
 *
 * A workspace origin on a different SITE (a different registrable domain, not
 * merely a different hostname) is a THIRD-PARTY frame, and browsers block its
 * cookies regardless of how they were set. The workspace origin must be
 * same-site with the UI — same host, a sibling subdomain, or a parent. That is
 * a browser rule, not a choice made here.
 */
import { createSession, invalidateSession, validateSession } from './session-store.js';

// The parameter name is shared with the browser side, which cannot import a
// server module — see $lib/workspace-ticket-param.ts.
export { WORKSPACE_TICKET_PARAM } from '$lib/workspace-ticket-param.js';

/**
 * One minute: long enough for a frame to load over a slow link, short enough
 * that a ticket sitting in a reverse proxy's access log is not a credential
 * anyone can still spend.
 */
export const WORKSPACE_TICKET_TTL_MS = 60_000;

/**
 * Mint a ticket for the browser that already holds a valid session. Callers
 * MUST have authenticated the request first (api/workspace/ticket does).
 */
export function mintWorkspaceTicket(): string {
  return createSession(WORKSPACE_TICKET_TTL_MS);
}

/**
 * Spend a ticket: true when it was valid, and it is invalid from here on.
 *
 * Single-use is enforced through the same in-memory revocation list logout
 * uses. That list is per-process and cleared on restart, which is precisely
 * enough: the listener redeeming the ticket IS the process that minted it, and
 * a ticket outlives a restart by at most its one-minute expiry anyway.
 */
export function redeemWorkspaceTicket(ticket: string): boolean {
  if (!validateSession(ticket)) return false;
  invalidateSession(ticket);
  return true;
}
